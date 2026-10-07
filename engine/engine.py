"""
Locus engine: drives iOS location simulation through pymobiledevice3.

Speaks newline-delimited JSON over stdin/stdout with the Electron shell:
  request   {"id": 1, "method": "teleport", "params": {...}}
  response  {"id": 1, "ok": true, "result": ...} | {"id": 1, "ok": false, "error": "...", "code": "..."}
  event     {"event": "position", "data": {...}}

All diagnostic output goes to stderr so stdout stays a clean protocol channel.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import platform
import random
import sys
import threading
import time
from contextlib import AsyncExitStack, suppress
from typing import Any, Optional

# Keep the protocol channel private: anything a dependency prints lands on stderr.
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
for noisy in ("asyncio", "urllib3", "pymobiledevice3", "zeroconf", "developer_disk_image"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
log = logging.getLogger("locus")

from pymobiledevice3 import usbmux  # noqa: E402
from pymobiledevice3.exceptions import (  # noqa: E402
    DeveloperModeIsNotEnabledError,
    NoDeviceConnectedError,
    PairingDialogResponsePendingError,
    PasswordRequiredError,
    UserDeniedPairingError,
    UserspaceTunnelUnavailableError,
)
from pymobiledevice3.lockdown import create_using_usbmux  # noqa: E402
from pymobiledevice3.services.amfi import AmfiService  # noqa: E402
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider  # noqa: E402
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation  # noqa: E402
from pymobiledevice3.services.mobile_image_mounter import auto_mount  # noqa: E402
from pymobiledevice3.services.simulate_location import DtSimulateLocation  # noqa: E402

IS_MAC = platform.system() == "Darwin"
EARTH_RADIUS_M = 6_371_008.8
TICK_SECONDS = 1.0
HEARTBEAT_SECONDS = 20.0


class EngineError(Exception):
    def __init__(self, message: str, code: str = "error"):
        super().__init__(message)
        self.code = code


# --------------------------------------------------------------------------- protocol


_out_lock = threading.Lock()


def _emit(obj: dict[str, Any]) -> None:
    line = json.dumps(obj, separators=(",", ":"), default=str)
    with _out_lock:
        _PROTOCOL_OUT.write(line + "\n")
        _PROTOCOL_OUT.flush()


def emit_event(name: str, data: Any = None) -> None:
    _emit({"event": name, "data": data})


# --------------------------------------------------------------------------- geo helpers


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def destination(origin: tuple[float, float], heading: float, distance_m: float) -> tuple[float, float]:
    lat1, lon1 = math.radians(origin[0]), math.radians(origin[1])
    brg = math.radians(heading)
    d = distance_m / EARTH_RADIUS_M
    lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(brg))
    lon2 = lon1 + math.atan2(math.sin(brg) * math.sin(d) * math.cos(lat1), math.cos(d) - math.sin(lat1) * math.sin(lat2))
    lon = (math.degrees(lon2) + 540) % 360 - 180
    return math.degrees(lat2), lon


def jittered(pos: tuple[float, float], meters: float) -> tuple[float, float]:
    if meters <= 0:
        return pos
    return destination(pos, random.uniform(0, 360), random.uniform(0, meters))


def validate_coord(lat: Any, lon: Any) -> tuple[float, float]:
    try:
        lat_f, lon_f = float(lat), float(lon)
    except (TypeError, ValueError):
        raise EngineError("Latitude and longitude must be numbers.", "bad_coordinate") from None
    if not (-90 <= lat_f <= 90 and -180 <= lon_f <= 180):
        raise EngineError("Coordinate out of range (lat −90…90, lon −180…180).", "bad_coordinate")
    return lat_f, lon_f


# --------------------------------------------------------------------------- devices


def _version_tuple(version: Optional[str]) -> tuple[int, ...]:
    if not version:
        return (0,)
    parts = []
    for p in version.split("."):
        try:
            parts.append(int(p))
        except ValueError:
            break
    return tuple(parts) or (0,)


async def discover_devices() -> list[dict[str, Any]]:
    """iPhones/iPads attached by USB cable. Wi-Fi connections are deliberately ignored."""
    try:
        mux_devices = await usbmux.list_devices()
    except Exception as e:  # usbmuxd / Apple Mobile Device Service not running
        log.warning("usbmux unavailable: %r", e)
        return []
    devices: dict[str, dict[str, Any]] = {}
    for dev in mux_devices:
        if not dev.is_usb or dev.serial in devices:
            continue
        udid = dev.serial
        entry: dict[str, Any] = {"udid": udid, "name": udid, "connection": "USB", "ios": None, "model": None}
        try:
            lockdown = await asyncio.wait_for(
                create_using_usbmux(serial=udid, autopair=False, connection_type="USB"), 6
            )
            try:
                entry["name"] = lockdown.all_values.get("DeviceName") or udid
                entry["ios"] = lockdown.product_version
                entry["model"] = lockdown.all_values.get("ProductType")
                entry["paired"] = True
                if _version_tuple(entry["ios"]) >= (16,):
                    with suppress(Exception):
                        enabled = await lockdown.get_developer_mode_status()
                        entry["developerMode"] = "enabled" if enabled else "disabled"
            finally:
                await lockdown.close()
        except Exception as e:
            entry["paired"] = False
            log.info("lockdown probe failed for %s: %r", udid, e)
        devices[udid] = entry
    return sorted(devices.values(), key=lambda d: d.get("name") or "")


# --------------------------------------------------------------------------- device session


class DeviceSession:
    """An open connection to one device that can set / clear its simulated location."""

    def __init__(self, udid: str, name: str, ios: str, transport: str):
        self.udid = udid
        self.name = name
        self.ios = ios
        self.transport = transport
        self._stack = AsyncExitStack()
        self._lock = asyncio.Lock()
        self._dvt_location: Optional[LocationSimulation] = None
        self._legacy: Optional[DtSimulateLocation] = None
        self.alive = True

    def info(self) -> dict[str, Any]:
        return {"udid": self.udid, "name": self.name, "ios": self.ios, "transport": self.transport}

    @classmethod
    async def open(cls, udid: str, on_progress=None) -> "DeviceSession":
        progress = on_progress or (lambda msg: None)
        known = {d["udid"].replace("-", "").upper(): d for d in await discover_devices()}
        dev = known.get(udid.replace("-", "").upper())
        if dev is None:
            raise EngineError("iPhone not found on USB. Connect it with a cable and unlock it.", "not_found")
        if dev.get("paired") is False:
            # Triggers the Trust prompt on the phone.
            progress("Waiting for “Trust This Computer” on the iPhone…")
            try:
                ld = await create_using_usbmux(serial=dev["udid"], autopair=True, pair_timeout=60, connection_type="USB")
                await ld.close()
            except (PairingDialogResponsePendingError, PasswordRequiredError):
                raise EngineError("Unlock the iPhone and tap “Trust”, then connect again.", "trust_pending") from None
            except UserDeniedPairingError:
                raise EngineError("Pairing was denied on the iPhone.", "trust_denied") from None
        if dev.get("developerMode") == "disabled":
            raise _developer_mode_error()

        ios = dev.get("ios") or "0"
        name = dev.get("name") or udid
        if _version_tuple(ios) >= (17,):
            return await cls._open_modern(dev, name, ios, progress)
        return await cls._open_legacy(dev, name, ios, progress)

    # iOS 17+: RSD tunnel -> DVT LocationSimulation channel, held open for the session.
    @classmethod
    async def _open_modern(cls, dev, name, ios, progress) -> "DeviceSession":
        udid = dev["udid"]
        # pymobiledevice3's in-process userspace tunnel over USB needs no root/admin and no Xcode
        # (iOS 17.4+). iOS 17.0-17.3 lacks the service it uses; on macOS those are reached through
        # the OS's own remoted tunnel instead (also no Xcode), elsewhere they need an admin tunnel.
        attempts = ["userspace"] + (["native"] if IS_MAC else [])
        errors = []
        for transport in attempts:
            session = cls(udid, name, ios, transport)
            try:
                progress("Opening developer tunnel…")
                if transport == "native":
                    from pymobiledevice3.remote.native_tunnel import NativeRemotedTunnel

                    rsd = await session._stack.enter_async_context(NativeRemotedTunnel(serial=udid))
                else:
                    from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel

                    rsd = await session._stack.enter_async_context(
                        UserspaceRsdTunnel(serial=udid, remotepairing_fallback=False)
                    )
                await session._ensure_ddi(rsd, progress)
                progress("Opening location channel…")
                dvt = await session._stack.enter_async_context(DvtProvider(rsd))
                session._dvt_location = await session._stack.enter_async_context(LocationSimulation(dvt))
                if transport == "native":
                    # The device keeps one RSD connection per tunnel and remoted wants it back; we only
                    # needed it to find the service port, so hand it over to evict each other less.
                    with suppress(Exception):
                        await rsd.close()
                return session
            except EngineError:
                await session.close()
                raise
            except DeveloperModeIsNotEnabledError:
                await session.close()
                raise _developer_mode_error() from None
            except UserspaceTunnelUnavailableError as e:
                await session.close()
                errors.append(f"{transport}: {e}")
                if not IS_MAC:
                    raise EngineError(
                        "iOS 17.0–17.3 needs an admin tunnel on Windows. Update the iPhone to iOS 17.4+ "
                        "or run `pymobiledevice3 remote tunneld` as Administrator.",
                        "needs_admin_tunnel",
                    ) from None
            except Exception as e:
                await session.close()
                log.exception("%s tunnel failed", transport)
                errors.append(f"{transport}: {e!r}")
        raise EngineError("Could not open a developer connection to the device. " + " | ".join(errors), "tunnel_failed")

    # iOS ≤ 16: lockdown developer service; needs the (non-personalized) DDI mounted.
    @classmethod
    async def _open_legacy(cls, dev, name, ios, progress) -> "DeviceSession":
        session = cls(dev["udid"], name, ios, "lockdown")
        try:
            lockdown = await create_using_usbmux(serial=dev["udid"], autopair=True, connection_type="USB")
            session._stack.push_async_callback(lockdown.close)
            await session._ensure_ddi(lockdown, progress)
            session._legacy = DtSimulateLocation(lockdown)
            return session
        except DeveloperModeIsNotEnabledError:
            await session.close()
            raise _developer_mode_error() from None
        except EngineError:
            await session.close()
            raise
        except Exception as e:
            await session.close()
            log.exception("legacy connect failed")
            raise EngineError(f"Could not connect: {e!r}", "connect_failed") from None

    async def _ensure_ddi(self, provider, progress) -> None:
        progress("Preparing developer image (first time can take a minute)…")
        try:
            await auto_mount(provider)
        except DeveloperModeIsNotEnabledError:
            raise
        except Exception as e:
            text = repr(e)
            if "AlreadyMounted" in text:
                return
            if "DeveloperModeIsNotEnabled" in text or "DeveloperMode" in type(e).__name__:
                raise DeveloperModeIsNotEnabledError() from None
            # Mounting can fail when it's already mounted under a different image; the location
            # channel will tell us for real if it's unusable.
            log.warning("DDI auto-mount: %r", e)

    async def set(self, lat: float, lon: float) -> None:
        async with self._lock:
            if not self.alive:
                raise EngineError("Device disconnected.", "disconnected")
            try:
                if self._dvt_location is not None:
                    await asyncio.wait_for(self._dvt_location.set(lat, lon), 10)
                else:
                    await asyncio.wait_for(self._legacy.set(lat, lon), 10)
            except Exception as e:
                self.alive = False
                raise EngineError(f"Lost connection to device ({e})", "disconnected") from None

    async def clear(self) -> None:
        async with self._lock:
            if not self.alive:
                return
            with suppress(Exception):
                if self._dvt_location is not None:
                    await asyncio.wait_for(self._dvt_location.clear(), 10)
                elif self._legacy is not None:
                    await asyncio.wait_for(self._legacy.clear(), 10)

    async def close(self) -> None:
        self.alive = False
        with suppress(Exception):
            await asyncio.wait_for(self._stack.aclose(), 10)


def _developer_mode_error() -> EngineError:
    return EngineError(
        "Developer Mode is off. On the iPhone open Settings › Privacy & Security › Developer Mode, "
        "turn it on and restart. (Use “Reveal Developer Mode” if the toggle is missing.)",
        "developer_mode",
    )


# --------------------------------------------------------------------------- movement


class Mover:
    """Owns the simulated position and the background motion (route / joystick)."""

    def __init__(self, engine: "Engine"):
        self.engine = engine
        self.position: Optional[tuple[float, float]] = None
        self.heading = 0.0
        self.mode = "idle"  # idle | static | route | joystick
        self.speed_mps = 1.4
        self.jitter_m = 0.0
        self.speed_variance = 0.0
        self.paused = False
        self._task: Optional[asyncio.Task] = None
        # route state
        self._route: list[tuple[float, float]] = []
        self._cum: list[float] = []
        self._travelled = 0.0
        self._loop = False
        # joystick state
        self._joy_heading: Optional[float] = None
        self._last_push = 0.0

    def snapshot(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "mode": self.mode,
            "paused": self.paused,
            "speedKmh": round(self.speed_mps * 3.6, 2),
            "heading": round(self.heading, 1),
        }
        if self.position:
            data["lat"], data["lon"] = self.position
        if self.mode == "route" and self._cum:
            total = self._cum[-1]
            data["progress"] = 0 if total == 0 else min(1.0, self._travelled / total)
            data["remainingM"] = max(0.0, total - self._travelled)
            data["etaS"] = data["remainingM"] / self.speed_mps if self.speed_mps > 0 else None
            data["totalM"] = total
        return data

    async def push(self, pos: tuple[float, float], jitter: bool = False) -> None:
        sent = jittered(pos, self.jitter_m) if jitter else pos
        await self.engine.require_session().set(*sent)
        self.position = pos
        self._last_push = time.monotonic()
        emit_event("position", self.snapshot())

    def _cancel(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None
        self.paused = False

    async def teleport(self, lat: float, lon: float) -> None:
        self._cancel()
        self.mode = "static"
        await self.push((lat, lon))
        self._task = asyncio.create_task(self._heartbeat())

    async def start_route(self, points: list[tuple[float, float]], speed_mps: float, loop: bool) -> None:
        if len(points) < 2:
            raise EngineError("A route needs at least two points.", "bad_route")
        self._cancel()
        self._route = points
        self._cum = [0.0]
        for a, b in zip(points, points[1:]):
            self._cum.append(self._cum[-1] + haversine_m(a, b))
        self._travelled = 0.0
        self._loop = loop
        self.speed_mps = speed_mps
        self.mode = "route"
        self.heading = bearing_deg(points[0], points[1])
        await self.push(points[0])
        self._task = asyncio.create_task(self._route_loop())

    def _route_point(self, dist: float) -> tuple[tuple[float, float], float]:
        cum = self._cum
        lo, hi = 0, len(cum) - 1
        while lo < hi - 1:
            mid = (lo + hi) // 2
            if cum[mid] <= dist:
                lo = mid
            else:
                hi = mid
        a, b = self._route[lo], self._route[hi]
        seg = cum[hi] - cum[lo]
        t = 0.0 if seg == 0 else (dist - cum[lo]) / seg
        pos = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        return pos, bearing_deg(a, b) if seg > 0 else self.heading

    async def _route_loop(self) -> None:
        try:
            total = self._cum[-1]
            last = time.monotonic()
            while True:
                # Sleep only what's left of the tick after the (possibly slow) previous push.
                await asyncio.sleep(max(0.05, TICK_SECONDS - (time.monotonic() - last)))
                now = time.monotonic()
                # Advance by real elapsed time so a slow transport doesn't slow the simulated speed.
                dt, last = min(now - last, 5.0), now
                if self.paused:
                    await self._maybe_heartbeat()
                    continue
                factor = 1 + random.uniform(-self.speed_variance, self.speed_variance)
                self._travelled += self.speed_mps * dt * factor
                if self._travelled >= total:
                    if self._loop and total > 0:
                        self._travelled %= total
                    else:
                        self._travelled = total
                        pos, self.heading = self._route_point(total)
                        await self.push(pos)
                        self.mode = "static"
                        emit_event("route_done", self.snapshot())
                        await self._heartbeat()
                        return
                pos, self.heading = self._route_point(self._travelled)
                await self.push(pos, jitter=True)
        except asyncio.CancelledError:
            raise
        except EngineError as e:
            await self.engine.on_session_error(e)

    async def joystick(self, heading: Optional[float], speed_mps: float) -> None:
        if self.position is None:
            raise EngineError("Set a starting location first (teleport somewhere).", "no_position")
        self.speed_mps = speed_mps
        self._joy_heading = heading
        if heading is not None:
            self.heading = heading
        if self.mode != "joystick" or self._task is None or self._task.done():
            self._cancel()
            self.mode = "joystick"
            self._task = asyncio.create_task(self._joystick_loop())

    async def _joystick_loop(self) -> None:
        step = 0.5  # finer ticks feel responsive while steering
        try:
            last = time.monotonic()
            while True:
                await asyncio.sleep(max(0.05, step - (time.monotonic() - last)))
                now = time.monotonic()
                dt, last = min(now - last, 5.0), now
                if self._joy_heading is None or self.paused:
                    await self._maybe_heartbeat()
                    continue
                factor = 1 + random.uniform(-self.speed_variance, self.speed_variance)
                nxt = destination(self.position, self._joy_heading, self.speed_mps * dt * factor)
                await self.push(nxt, jitter=True)
        except asyncio.CancelledError:
            raise
        except EngineError as e:
            await self.engine.on_session_error(e)

    async def _heartbeat(self) -> None:
        # Re-assert the fixed location periodically; harmless and survives transient hiccups.
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_SECONDS)
                await self._maybe_heartbeat()
        except asyncio.CancelledError:
            raise
        except EngineError as e:
            await self.engine.on_session_error(e)

    async def _maybe_heartbeat(self) -> None:
        if self.position and time.monotonic() - self._last_push >= HEARTBEAT_SECONDS:
            await self.engine.require_session().set(*self.position)
            self._last_push = time.monotonic()

    def stop_motion(self) -> None:
        was_moving = self.mode in ("route", "joystick")
        self._cancel()
        if self.position is not None:
            self.mode = "static"
            if was_moving:
                self._task = asyncio.create_task(self._heartbeat())
        else:
            self.mode = "idle"

    def reset(self) -> None:
        self._cancel()
        self.mode = "idle"
        self.position = None


# --------------------------------------------------------------------------- engine


class Engine:
    def __init__(self):
        self.session: Optional[DeviceSession] = None
        self.mover = Mover(self)
        self._reconnecting = False
        self.inbox: asyncio.Queue[Optional[str]] = asyncio.Queue()

    def require_session(self) -> DeviceSession:
        if self.session is None or not self.session.alive:
            raise EngineError("No device connected.", "no_device")
        return self.session

    async def on_session_error(self, err: EngineError) -> None:
        if self._reconnecting or self.session is None:
            return
        self._reconnecting = True
        udid = self.session.udid
        emit_event("status", {"state": "reconnecting", "message": str(err)})
        try:
            await self.session.close()
            for attempt in range(1, 6):
                await asyncio.sleep(min(2 * attempt, 8))
                try:
                    self.session = await DeviceSession.open(udid)
                    log.info("reconnected on attempt %d", attempt)
                    resume_pos = self.mover.position
                    if resume_pos:
                        # Restart whatever was running, from where it was.
                        if self.mover.mode == "route":
                            await self.session.set(*resume_pos)
                            self.mover._task = asyncio.create_task(self.mover._route_loop())
                        elif self.mover.mode == "joystick":
                            await self.session.set(*resume_pos)
                            self.mover._task = asyncio.create_task(self.mover._joystick_loop())
                        else:
                            await self.mover.teleport(*resume_pos)
                    emit_event("status", {"state": "connected", "device": self.session.info()})
                    return
                except Exception as e:
                    log.info("reconnect attempt %d failed: %r", attempt, e)
            self.session = None
            self.mover.reset()
            emit_event("status", {"state": "disconnected", "message": "Device connection lost."})
        finally:
            self._reconnecting = False

    # ---- RPC methods -------------------------------------------------------------

    async def m_ping(self, _):
        return {"pong": True, "platform": platform.system(), "python": platform.python_version()}

    async def m_list_devices(self, _):
        return await discover_devices()

    async def m_connect(self, p):
        udid = p.get("udid")
        if not udid:
            raise EngineError("No device selected.", "bad_request")
        if self.session:
            await self.m_disconnect({"clear": False})
        emit_event("status", {"state": "connecting", "message": "Connecting…"})

        def progress(msg: str) -> None:
            emit_event("status", {"state": "connecting", "message": msg})

        try:
            self.session = await DeviceSession.open(udid, progress)
        except Exception:
            emit_event("status", {"state": "disconnected"})
            raise
        info = self.session.info()
        emit_event("status", {"state": "connected", "device": info})
        return info

    async def m_disconnect(self, p):
        clear = p.get("clear", True)
        self.mover.reset()
        if self.session:
            if clear:
                await self.session.clear()
            await self.session.close()
        self.session = None
        emit_event("status", {"state": "disconnected"})
        return True

    async def m_teleport(self, p):
        lat, lon = validate_coord(p.get("lat"), p.get("lon"))
        await self.mover.teleport(lat, lon)
        return self.mover.snapshot()

    async def m_route_start(self, p):
        pts = [validate_coord(a, b) for a, b in (p.get("points") or [])]
        speed = _speed_mps(p.get("speedKmh", 5))
        await self.mover.start_route(pts, speed, bool(p.get("loop")))
        return self.mover.snapshot()

    async def m_pause(self, _):
        self.mover.paused = True
        emit_event("position", self.mover.snapshot())
        return True

    async def m_resume(self, _):
        self.mover.paused = False
        emit_event("position", self.mover.snapshot())
        return True

    async def m_stop_motion(self, _):
        self.mover.stop_motion()
        emit_event("position", self.mover.snapshot())
        return True

    async def m_set_options(self, p):
        if "speedKmh" in p:
            self.mover.speed_mps = _speed_mps(p["speedKmh"])
        if "jitterM" in p:
            self.mover.jitter_m = max(0.0, min(25.0, float(p["jitterM"])))
        if "speedVariance" in p:
            self.mover.speed_variance = max(0.0, min(0.5, float(p["speedVariance"])))
        return self.mover.snapshot()

    async def m_joystick(self, p):
        heading = p.get("heading")
        await self.mover.joystick(None if heading is None else float(heading) % 360, _speed_mps(p.get("speedKmh", 5)))
        return True

    async def m_clear(self, _):
        self.mover.reset()
        await self.require_session().clear()
        emit_event("position", self.mover.snapshot())
        return True

    async def m_reveal_developer_mode(self, p):
        udid = p.get("udid")
        try:
            lockdown = await create_using_usbmux(serial=udid, autopair=False, connection_type="USB")
        except NoDeviceConnectedError:
            raise EngineError("Connect the iPhone with a USB cable to reveal Developer Mode.", "not_found") from None
        try:
            await AmfiService(lockdown).reveal_developer_mode_option_in_ui()
        finally:
            await lockdown.close()
        return True

    async def m_shutdown(self, p):
        with suppress(Exception):
            await self.m_disconnect({"clear": p.get("clear", True)})
        return True


def _speed_mps(kmh: Any) -> float:
    try:
        v = float(kmh)
    except (TypeError, ValueError):
        raise EngineError("Speed must be a number.", "bad_request") from None
    return max(0.1, min(v, 1000.0)) / 3.6


# --------------------------------------------------------------------------- main loop


async def handle(engine: Engine, msg: dict[str, Any]) -> None:
    req_id = msg.get("id")
    method = msg.get("method", "")
    fn = getattr(engine, f"m_{method}", None)
    if fn is None:
        _emit({"id": req_id, "ok": False, "error": f"Unknown method {method!r}", "code": "bad_method"})
        return
    try:
        result = await fn(msg.get("params") or {})
        _emit({"id": req_id, "ok": True, "result": result})
    except EngineError as e:
        _emit({"id": req_id, "ok": False, "error": str(e), "code": e.code})
    except Exception as e:
        log.exception("method %s failed", method)
        _emit({"id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}", "code": "internal"})
    if method == "shutdown":
        engine.inbox.put_nowait(None)


async def main() -> None:
    loop = asyncio.get_running_loop()
    engine = Engine()
    queue = engine.inbox

    def reader() -> None:
        for line in sys.stdin:
            loop.call_soon_threadsafe(queue.put_nowait, line)
        loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=reader, daemon=True, name="stdin-reader").start()
    emit_event("ready", {"platform": platform.system()})
    tasks: set[asyncio.Task] = set()
    while True:
        line = await queue.get()
        if line is None:  # parent went away, or shutdown was requested
            with suppress(Exception):
                await asyncio.wait_for(engine.m_shutdown({"clear": True}), 8)
            return
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            log.warning("bad json from host: %r", line[:200])
            continue
        task = asyncio.create_task(handle(engine, msg))
        tasks.add(task)
        task.add_done_callback(tasks.discard)


if __name__ == "__main__":
    with suppress(KeyboardInterrupt):
        asyncio.run(main())
