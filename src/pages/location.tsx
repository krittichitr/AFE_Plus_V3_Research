import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/router'
import axios from 'axios'
import Link from 'next/link'

import { useGoogleMaps } from '@/providers/GoogleMapsProvider';
import { encrypt } from '@/utils/helpers'

import Map, { Marker, MapRef, Source, Layer } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Map as MapIcon, Layers, Navigation, Compass, ChevronRight, MapPin, Globe } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// Ported from Navigation Frontend's components/CustomCompass.tsx (Phase 4C-1).
// Kept inline here (rather than a new component file) because this phase's
// scope is limited to src/pages/location.tsx only. Self-contained — no
// external state, no AFE coupling.
interface CustomCompassProps {
    bearing: number;
    onTap: () => void;
    size?: number;
}

function CustomCompass({ bearing, onTap, size = 55 }: CustomCompassProps) {
    return (
        <div
            onClick={onTap}
            className="bg-white rounded-full flex items-center justify-center cursor-pointer transition-shadow hover:shadow-lg"
            style={{
                width: size,
                height: size,
                boxShadow: '0 2px 10px rgba(0,0,0,0.12)'
            }}
        >
            <div
                style={{
                    transform: `rotate(${-bearing}deg)`,
                    transition: 'transform 0.3s ease-out',
                    width: '100%',
                    height: '100%',
                    position: 'relative'
                }}
            >
                <svg viewBox="0 0 100 100" className="w-full h-full drop-shadow-sm">
                    <polygon points="50,12.5 50,50 36,50" fill="#EF5350" />
                    <polygon points="50,12.5 64,50 50,50" fill="#E53935" />
                    <polygon points="50,87.5 50,50 36,50" fill="#6B6B6B" />
                    <polygon points="50,87.5 64,50 50,50" fill="#4A4A4A" />
                </svg>
            </div>
        </div>
    );
}

// --- Overview (Mapbox) constants ---
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";
const defaultCenter = { lat: 16.7422, lng: 100.1936 };
const GPS_FRESHNESS_MAX_AGE_MS = 15_000;
const RESEARCH_LOCATION_ENTRY_ENABLED =
    process.env.NEXT_PUBLIC_RESEARCH_LOCATION_ENTRY_ENABLED === 'true';

const parsePositiveSafeIntegerQuery = (value: string | string[] | undefined): number | null => {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

type MapCoordinate = {
    lat: number;
    lng: number;
};

// Pure helper — builds a GeoJSON circle polygon of `radiusMeters` (real-world
// meters, not pixels) around `center`, for rendering Safe Zone radii on
// Mapbox via a Source/Layer fill (not a `circle-radius` paint property, whose
// unit is pixels and would not represent a true meter radius). No dependency
// added — great-circle destination-point math implemented inline.
function createCirclePolygon(
    center: MapCoordinate,
    radiusMeters: number,
    points = 64,
): GeoJSON.Feature<GeoJSON.Polygon> {
    const earthRadiusM = 6_371_000;
    const angularDistance = radiusMeters / earthRadiusM;
    const latRad = center.lat * Math.PI / 180;
    const lngRad = center.lng * Math.PI / 180;
    const coordinates: [number, number][] = [];

    for (let i = 0; i <= points; i += 1) {
        const bearing = (i / points) * 2 * Math.PI;

        const lat2 = Math.asin(
            Math.sin(latRad) * Math.cos(angularDistance) +
            Math.cos(latRad) *
                Math.sin(angularDistance) *
                Math.cos(bearing),
        );

        const lng2 =
            lngRad +
            Math.atan2(
                Math.sin(bearing) *
                    Math.sin(angularDistance) *
                    Math.cos(latRad),
                Math.cos(angularDistance) -
                    Math.sin(latRad) * Math.sin(lat2),
            );

        coordinates.push([
            lng2 * 180 / Math.PI,
            lat2 * 180 / Math.PI,
        ]);
    }

    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [coordinates],
        },
    };
}

interface DataUserState {
    isLogin: boolean;
    userData: any | null
    takecareData: any | null
}

const Location = () => {
    const router = useRouter();
    const { isLoaded } = useGoogleMaps(); // legacy Google Maps script-loaded flag — still used by the auth effect below, not used to gate render this phase
    const mapRef = useRef<MapRef>(null); // Overview/Mapbox map ref

    const researchUsersId = parsePositiveSafeIntegerQuery(router.query.users_id);
    const researchTakecareId = parsePositiveSafeIntegerQuery(router.query.takecare_id);
    const isResearchEntryRequested =
        RESEARCH_LOCATION_ENTRY_ENABLED && !router.query.auToken;
    const isResearchEntry =
        isResearchEntryRequested &&
        researchUsersId !== null &&
        researchTakecareId !== null;

    // ════════════════════════════════════════════════════════════════════
    // AFE STATE/LOGIC — auth, Safe Zone, patient polling, GPS watcher. This is
    // the single source of truth for real data (patientPos, myPos/
    // myPosUpdatedAt, dataUser, safezonePos). The Overview UI below reads from
    // this state via derived consts (patientLocation, userLocation,
    // userLocationUpdatedAt, gpsAgeMs, isGpsFresh, isStartDisabled) instead of
    // keeping its own parallel copies — consolidated in Phase 4C-2.
    //
    // The Google-Maps-only map-instance ref/state, padding, directions,
    // routeInfo, a route-timing ref, an info-window state, a map-type toggle,
    // a map-load callback, a marker-click handler, and a Google-Maps-center
    // memo (plus their supporting imports/constants) were removed in Phase
    // 4C-4 — they had zero consumers left
    // after the Google Maps JSX tree was already dropped from render in
    // Phase 4C-1. `heading`/`setHeading` is kept (still fed by this GPS
    // watcher and the compass-heading effect below, per Phase 4C-4C
    // instructions) even though no UI currently reads it. `autoFollow` is also
    // kept for now — its only consumer (the Google-Maps pan-to block) was
    // removed from the GPS watcher in Phase 4C-4D, so it is currently
    // fully unused, but its removal was not part of this phase's explicit
    // scope.
    // ════════════════════════════════════════════════════════════════════
    const [isLoading, setLoading] = useState(true);
    const [alert, setAlert] = useState({ show: false, message: '' });

    // Data
    const [dataUser, setDataUser] = useState<DataUserState>({ isLogin: false, userData: null, takecareData: null });
    const [safezonePos, setSafezonePos] = useState({ lat: 0, lng: 0 }); // Was 'origin'
    const [patientPos, setPatientPos] = useState({ lat: 0, lng: 0 });   // Was 'destination'
    const [myPos, setMyPos] = useState<google.maps.LatLngLiteral | null>(null);
    const [myPosUpdatedAt, setMyPosUpdatedAt] = useState<number | null>(null);

    // UI/Map State
    const [heading, setHeading] = useState<number>(0);
    const [range1, setRange1] = useState(10);
    const [range2, setRange2] = useState(20);

    const [autoFollow, setAutoFollow] = useState(true);

    // --- Effects ---

    // --- Helpers ---

    const onGetLocation = useCallback(async (safezoneData: any, takecareData: any, userData: any, researchEntry = false) => {
        try {
            const locationUrl = researchEntry
                ? `/api/navigate/target-location?users_id=${userData.users_id}&takecare_id=${takecareData.takecare_id}`
                : `/api/location/getLocation?takecare_id=${takecareData.takecare_id}&users_id=${userData.users_id}&safezone_id=${safezoneData.safezone_id}&location_id=${router.query.idlocation}`;
            const resLocation = await axios.get(locationUrl);
            if (resLocation.data?.data) {
                const data = resLocation.data?.data;
                setPatientPos({
                    lat: Number(researchEntry ? data.lat : data.locat_latitude),
                    lng: Number(researchEntry ? data.lng : data.locat_longitude),
                });
            } else if (!researchEntry) {
                // Fallback to Safezone center if no location
                setPatientPos({
                    lat: Number(safezoneData.safez_latitude),
                    lng: Number(safezoneData.safez_longitude),
                });
            } else {
                setPatientPos({ lat: 0, lng: 0 });
            }
            setLoading(false);
        } catch (error) {
            console.error("Location error:", error);
            if (researchEntry) setPatientPos({ lat: 0, lng: 0 });
            setLoading(false);
        }
    }, [router.query.idlocation]);

    const onGetSafezone = useCallback(async (idSafezone: string, takecareData: any, userData: any, researchEntry = false) => {
        try {
            const safezoneUrl = researchEntry
                ? `/api/setting/getSafezone?takecare_id=${takecareData.takecare_id}&users_id=${userData.users_id}`
                : `/api/setting/getSafezone?takecare_id=${takecareData.takecare_id}&users_id=${userData.users_id}&id=${idSafezone}`;
            const resSafezone = await axios.get(safezoneUrl);
            if (resSafezone.data?.data) {
                const data = resSafezone.data?.data;
                setSafezonePos({
                    lat: Number(data.safez_latitude),
                    lng: Number(data.safez_longitude),
                });
                setRange1(data.safez_radiuslv1);
                setRange2(data.safez_radiuslv2);

                // Also get initial location to be sure
                onGetLocation(data, takecareData, userData, researchEntry);
            }
        } catch (error) {
            console.error("Safezone error:", error);
            setLoading(false);
        }
    }, [onGetLocation]);

    const alertModal = () => {
        setAlert({ show: true, message: 'ระบบไม่สามารถดึงข้อมูลของท่านได้ กรุณาลองใหม่อีกครั้ง' });
        setDataUser({ isLogin: false, userData: null, takecareData: null });
        setLoading(false);
    }

    const onGetUserData = useCallback(async (auToken: string) => {
        try {
            const responseUser = await axios.get(`/api/user/getUser/${auToken}`);
            if (responseUser.data?.data) {
                const encodedUsersId = encrypt(responseUser.data?.data.users_id.toString());
                const responseTakecareperson = await axios.get(`/api/user/getUserTakecareperson/${encodedUsersId}`);
                const data = responseTakecareperson.data?.data;

                if (data) {
                    setDataUser({ isLogin: true, userData: responseUser.data?.data, takecareData: data });
                    // Note: onGetSafezone is defined above, but we need to ensure it's accessible.
                    // Since it's inside the component, it is. But for useCallback dependency,
                    // we might get a warning if we don't include it, but let's stick to simple fix first.
                    onGetSafezone(router.query.idsafezone as string, data, responseUser.data?.data);
                } else {
                    alertModal();
                }
            } else {
                alertModal();
            }
        } catch (error) {
            console.error("Auth error:", error);
            alertModal();
        }
    }, [router.query.idsafezone, onGetSafezone]); // Add dep

    // --- Effects ---

    // 2. Compass Heading — feeds `heading` (kept per Phase 4C-4C — see state block comment above)
    useEffect(() => {
        const handleOrientation = (event: DeviceOrientationEvent) => {
            // @ts-ignore
            if (event.webkitCompassHeading) {
                // @ts-ignore
                setHeading(event.webkitCompassHeading);
            } else if (event.alpha) {
                setHeading(360 - event.alpha);
            }
        };
        if (typeof window !== "undefined" && window.DeviceOrientationEvent) {
            window.addEventListener("deviceorientation", handleOrientation as any, true);
        }
        return () => {
            if (typeof window !== "undefined") {
                window.removeEventListener("deviceorientation", handleOrientation as any);
            }
        };
    }, []);

    // 3. User Location (GPS) — AFE's single GPS watcher. Feeds myPos/
    // myPosUpdatedAt (source of truth for Overview's userLocation, consumed
    // by the Mapbox camera effect/handleCenterCamera below) and heading. The
    // Google-Maps pan-to/follow-mode block (map-instance follow call) was
    // removed in Phase 4C-4D — Mapbox's own camera (isCameraCentered/isInitialFitDone/
    // fitBounds/flyTo) now owns all camera-follow behavior.
    useEffect(() => {
        if (!navigator.geolocation) return;
        const watchId = navigator.geolocation.watchPosition(
            (position) => {
                const { latitude, longitude, heading: gpsHeading } = position.coords;
                const newPos = { lat: latitude, lng: longitude };
                setMyPos(newPos);
                setMyPosUpdatedAt(Date.now());

                if (gpsHeading !== null && !isNaN(gpsHeading) && position.coords.speed && position.coords.speed > 1) {
                    setHeading(gpsHeading);
                }
            },
            (error) => console.error("Error getting location:", error),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
        return () => navigator.geolocation.clearWatch(watchId);
    }, []);

    // --- Helpers for Distance ---
    const toRad = (d: number) => (d * Math.PI) / 180;
    const getDistance = (p1: { lat: number, lng: number }, p2: { lat: number, lng: number }) => {
        const R = 6371e3; // Earth radius in meters
        const φ1 = toRad(p1.lat);
        const φ2 = toRad(p2.lat);
        const Δφ = toRad(p2.lat - p1.lat);
        const Δλ = toRad(p2.lng - p1.lng);
        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    };

    // 4. API Polling (Patient Location) - Dynamic Interval — legacy, still runs in the background
    useEffect(() => {
        if (!dataUser?.takecareData?.userData?.origin?.lat && !dataUser.isLogin) return;

        const fetchLocation = async () => {
            try {
                const url = isResearchEntry
                    ? `/api/navigate/target-location?users_id=${dataUser.userData.users_id}&takecare_id=${dataUser.takecareData.takecare_id}`
                    : `/api/location/getLocation?takecare_id=${dataUser.takecareData.takecare_id}&users_id=${dataUser.userData.users_id}`;
                const resLocation = await axios.get(url);

                if (resLocation.data?.data) {
                    const data = resLocation.data.data;
                    setPatientPos({
                        lat: Number(isResearchEntry ? data.lat : data.locat_latitude),
                        lng: Number(isResearchEntry ? data.lng : data.locat_longitude),
                    });
                }
            } catch (err) {
                console.log("realtime location error", err);
            }
        };

        // Helpers for Distance (Local Scope)
        const toRad = (d: number) => (d * Math.PI) / 180;
        const getDistance = (p1: { lat: number, lng: number }, p2: { lat: number, lng: number }) => {
            const R = 6371e3; // Earth radius in meters
            const φ1 = toRad(p1.lat);
            const φ2 = toRad(p2.lat);
            const Δφ = toRad(p2.lat - p1.lat);
            const Δλ = toRad(p2.lng - p1.lng);
            const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        };

        // Initial fetch
        if (dataUser.userData) fetchLocation();

        // Determine Interval
        let intervalDuration = 3000; // Default: Fast (3s) for Safety/Outside

        // Only switch to Slow (30s) if confirmed INSIDE safezone
        if (safezonePos.lat !== 0 && patientPos.lat !== 0) {
            const dist = getDistance(safezonePos, patientPos);
            if (dist <= range1) {
                intervalDuration = 30000; // Inside Safezone: Slow (30s)
            } else {
                intervalDuration = 3000; // Outside Safezone: Fast (3s)
                // console.log("Outside Safezone (" + Math.round(dist) + "m). Polling every 3s.");
            }
        }

        const interval = setInterval(fetchLocation, intervalDuration);
        return () => clearInterval(interval);
    }, [dataUser, safezonePos, patientPos, range1, isResearchEntry]);

    // 5. Auth & Initial Data Load — legacy, still runs in the background
    useEffect(() => {
        if (!router.isReady) return;

        const auToken = router.query.auToken;
        if (auToken && isLoaded) {
            onGetUserData(auToken as string);
        } else if (!auToken && isResearchEntry) {
            const userData = { users_id: researchUsersId };
            const takecareData = { takecare_id: researchTakecareId };
            setDataUser({ isLogin: true, userData, takecareData });
            onGetSafezone('', takecareData, userData, true);
        } else if (!auToken && isResearchEntryRequested) {
            setDataUser({ isLogin: false, userData: null, takecareData: null });
            setPatientPos({ lat: 0, lng: 0 });
            setLoading(false);
            setAlert({ show: true, message: "ไม่พบข้อมูลการเข้าสู่ระบบ (auToken Missing)" });
        } else if (isLoaded && !auToken) {
            setLoading(false);
            setAlert({ show: true, message: "ไม่พบข้อมูลการเข้าสู่ระบบ (auToken Missing)" });
        }
    }, [
        router.query.auToken,
        isLoaded,
        router.isReady,
        isResearchEntryRequested,
        isResearchEntry,
        researchUsersId,
        researchTakecareId,
        onGetUserData,
        onGetSafezone,
    ]);

    const handleEmergencyNav = () => {
        if (
            !patientPos ||
            !Number.isFinite(patientPos.lat) ||
            !Number.isFinite(patientPos.lng) ||
            (patientPos.lat === 0 && patientPos.lng === 0)
        ) {
            setAlert({ show: true, message: 'ไม่พบตำแหน่งผู้ป่วย' });
            return;
        }
        const url = `https://www.google.com/maps/dir/?api=1&destination=${patientPos.lat},${patientPos.lng}`;
        window.open(url, "_blank");
    };

    const hasValidTargetPosition =
        Number.isFinite(patientPos.lat) &&
        Number.isFinite(patientPos.lng) &&
        !(patientPos.lat === 0 && patientPos.lng === 0);

    const hasResolvedNavigationIdentity =
        Number.isInteger(Number(dataUser.userData?.users_id)) &&
        Number(dataUser.userData?.users_id) > 0 &&
        Number.isInteger(Number(dataUser.takecareData?.takecare_id)) &&
        Number(dataUser.takecareData?.takecare_id) > 0;

    // Safe Zone validity + GeoJSON memoization (Phase 4C-3B) — safezonePos/
    // range1/range2 remain AFE's own state (set only by onGetSafezone); these
    // are read-only derived checks/values, no mutation of the source state.
    const hasValidSafeZone =
        Number.isFinite(safezonePos.lat) &&
        Number.isFinite(safezonePos.lng) &&
        !(safezonePos.lat === 0 && safezonePos.lng === 0);

    const hasValidRange1 =
        Number.isFinite(range1) &&
        range1 > 0;

    const hasValidRange2 =
        Number.isFinite(range2) &&
        range2 > 0;

    const safeZoneLevel1GeoJson = useMemo(() => {
        if (!hasValidSafeZone || !hasValidRange1) {
            return null;
        }

        return createCirclePolygon(safezonePos, range1);
    }, [hasValidSafeZone, hasValidRange1, safezonePos, range1]);

    const safeZoneLevel2GeoJson = useMemo(() => {
        if (!hasValidSafeZone || !hasValidRange2) {
            return null;
        }

        return createCirclePolygon(safezonePos, range2);
    }, [hasValidSafeZone, hasValidRange2, safezonePos, range2]);

    // Legacy /navigation query template — reused as-is (unchanged derivation)
    // by the Overview "Web Application" / desktop start buttons below, per
    // Phase 4C-1 instructions ("Web Application ยังใช้ Link/query เดิม").
    const legacyNavigateHref = `/navigation?idlocation=${router.query.idlocation || ''}&users_id=${dataUser.userData?.users_id || ''}&takecare_id=${dataUser.takecareData?.takecare_id || ''}&auToken=${router.query.auToken || ''}`;
    // ════════════════════════════════════════════════════════════════════
    // OVERVIEW (MAPBOX) UI — new primary UI for this page (Phase 4C-1).
    // Ported from afe-navigation-frontend-production/app/overview/page.tsx.
    //
    // Phase 4C-2: patientLocation/userLocation/userLocationUpdatedAt are no
    // longer separate state — they are derived directly from AFE's own
    // patientPos/myPos/myPosUpdatedAt (source of truth). AFE's single GPS
    // watcher (effect #3 above) and patient-polling effect (#4 above) are
    // what actually update the underlying data; these consts just re-view it
    // under the names the ported Overview JSX below already uses.
    // ════════════════════════════════════════════════════════════════════
    const patientLocation = hasValidTargetPosition ? patientPos : null;
    const userLocation = myPos;
    const userLocationUpdatedAt = myPosUpdatedAt;
    const [nowMs, setNowMs] = useState(() => Date.now());

    const [isSatellite, setIsSatellite] = useState(false);
    const [isCameraCentered, setIsCameraCentered] = useState(true);
    const [isMenuExpanded, setIsMenuExpanded] = useState(false);
    const [mapHeading, setMapHeading] = useState(0);

    // --- State เพิ่มเติมสำหรับเช็คว่าซูมครั้งแรกไปหรือยัง ---
    const [isInitialFitDone, setIsInitialFitDone] = useState(false);

    // Consolidated GPS freshness (Phase 4C-2) — single ticker (nowMs, Overview's
    // own name per "Overview เป็นเจ้าของชื่อสุดท้าย"), single timestamp source
    // (myPosUpdatedAt, AFE's real GPS watcher — "AFE เป็นเจ้าของข้อมูลจริง").
    const gpsAgeMs =
        myPosUpdatedAt !== null ? nowMs - myPosUpdatedAt : null;

    const isGpsFresh =
        myPos !== null &&
        gpsAgeMs !== null &&
        gpsAgeMs <= GPS_FRESHNESS_MAX_AGE_MS;

    const isStartDisabled =
        !isGpsFresh ||
        !hasValidTargetPosition ||
        !hasResolvedNavigationIdentity;

    // Mobile handoff URI — matches the Flutter app's NavigationLaunchContext
    // .fromUri contract (scheme `afeplus`, host `navigation`; required
    // users_id/takecare_id, optional idlocation). auToken is deliberately NOT
    // forwarded: it is the LINE user id that withRlsAuth accepts as a
    // credential, and any app may register the `afeplus` scheme and intercept
    // the link. The Flutter app never reads it — the endpoints it calls
    // (/api/navigate/target-location, /api/setting/getSafezone) use withRls,
    // not withRlsAuth — so omitting it costs nothing.
    const mobileAppNativeHref = useMemo(() => {
        if (!hasResolvedNavigationIdentity) return null;
        const params = new URLSearchParams();
        params.set('users_id', String(dataUser.userData?.users_id));
        params.set('takecare_id', String(dataUser.takecareData?.takecare_id));
        if (typeof router.query.idlocation === 'string' && router.query.idlocation) {
            params.set('idlocation', router.query.idlocation);
        }
        return `afeplus://navigation?${params.toString()}`;
    }, [
        dataUser.takecareData?.takecare_id,
        dataUser.userData?.users_id,
        hasResolvedNavigationIdentity,
        router.query.idlocation,
    ]);
    const handleMobileAppNative = useCallback(() => {
        if (isStartDisabled || !mobileAppNativeHref) {
            setAlert({ show: true, message: 'รอข้อมูลก่อนเริ่มนำทางผ่านแอป' });
            return;
        }
        window.location.href = mobileAppNativeHref;
        window.setTimeout(() => {
            setAlert({ show: true, message: 'ไม่พบแอป AFE+ กรุณาติดตั้งแอปก่อน' });
        }, 1200);
    }, [isStartDisabled, mobileAppNativeHref]);

    useEffect(() => {
        const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    // 💡 Map Camera Controller (fitBounds ครั้งแรก ให้โชว์ 2 หมุด)
    useEffect(() => {
        if (!mapRef.current || !patientLocation) return;
        const map = mapRef.current;

        // 1. ถ้ามีครบทั้งพิกัดเราและพิกัดคนไข้ และยังไม่เคยจัดหน้าจอ (เปิดแอปครั้งแรก)
        if (userLocation && !isInitialFitDone) {
            map.fitBounds(
                [
                    [Math.min(userLocation.lng, patientLocation.lng), Math.min(userLocation.lat, patientLocation.lat)],
                    [Math.max(userLocation.lng, patientLocation.lng), Math.max(userLocation.lat, patientLocation.lat)],
                ],
                { padding: { top: 100, bottom: 400, left: 50, right: 50 }, duration: 1000 }
            );
            setIsInitialFitDone(true);
        }
        // 2. ถ้ากดปุ่ม "ปรับจุดกลาง" หลังจากนั้น ให้กล้องแพนไปหาตัวเราแบบนุ่มนวล
        else if (isCameraCentered && isInitialFitDone && userLocation) {
            map.flyTo({ center: [userLocation.lng, userLocation.lat], duration: 800 });
        }
    }, [patientLocation, userLocation, isCameraCentered, isInitialFitDone]);

    // ฟังก์ชันเวลากดปุ่ม "ปรับจุดกลาง"
    const handleCenterCamera = () => {
        setIsCameraCentered(true);
        if (mapRef.current && userLocation) {
            mapRef.current.flyTo({ center: [userLocation.lng, userLocation.lat], duration: 800 });
        }
    };

    return (
        <main className="relative w-full h-[100dvh] overflow-hidden bg-gray-100 font-sans">

            {/* --- MAP LAYER --- */}
            <div className="absolute inset-0">
                <Map
                    ref={mapRef}
                    mapboxAccessToken={MAPBOX_TOKEN}
                    initialViewState={{
                        longitude: defaultCenter.lng,
                        latitude: defaultCenter.lat,
                        zoom: 17,
                    }}
                    style={{ width: "100%", height: "100%" }}
                    mapStyle={isSatellite ? "mapbox://styles/mapbox/satellite-streets-v12" : "mapbox://styles/mapbox/streets-v12"}
                    onDragStart={() => setIsCameraCentered(false)}
                    onMove={(e) => setMapHeading(e.viewState.bearing)}
                    attributionControl={false}
                >
                    {safeZoneLevel2GeoJson && (
                        <Source
                            id="safe-zone-level-2-source"
                            type="geojson"
                            data={safeZoneLevel2GeoJson}
                        >
                            <Layer
                                id="safe-zone-level-2-fill"
                                type="fill"
                                paint={{
                                    'fill-color': '#F24C3D',
                                    'fill-opacity': 0.10,
                                }}
                            />
                            <Layer
                                id="safe-zone-level-2-line"
                                type="line"
                                paint={{
                                    'line-color': '#F24C3D',
                                    'line-width': 2,
                                }}
                            />
                        </Source>
                    )}

                    {safeZoneLevel1GeoJson && (
                        <Source
                            id="safe-zone-level-1-source"
                            type="geojson"
                            data={safeZoneLevel1GeoJson}
                        >
                            <Layer
                                id="safe-zone-level-1-fill"
                                type="fill"
                                paint={{
                                    'fill-color': '#F2BE22',
                                    'fill-opacity': 0.20,
                                }}
                            />
                            <Layer
                                id="safe-zone-level-1-line"
                                type="line"
                                paint={{
                                    'line-color': '#F2BE22',
                                    'line-width': 2,
                                }}
                            />
                        </Source>
                    )}

                    {hasValidSafeZone && (
                        <Marker
                            longitude={safezonePos.lng}
                            latitude={safezonePos.lat}
                            anchor="bottom"
                        >
                            <img
                                src="https://maps.google.com/mapfiles/kml/pal2/icon10.png"
                                alt="Safe Zone center"
                                width={35}
                                height={35}
                                style={{
                                    width: 35,
                                    height: 35,
                                    objectFit: 'contain',
                                }}
                            />
                        </Marker>
                    )}

                    {/* หมุดคนไข้ */}
                    {patientLocation && (
                        <Marker longitude={patientLocation.lng} latitude={patientLocation.lat} anchor="bottom">
                            <img src="/marker.png" alt="Patient" style={{ width: 45, height: 45, objectFit: "contain", filter: "drop-shadow(0px 4px 6px rgba(0,0,0,0.3))" }} />
                        </Marker>
                    )}

                    {/* หมุดตัวเรา (สีฟ้า) */}
                    {userLocation && (
                        <Marker longitude={userLocation.lng} latitude={userLocation.lat} anchor="center">
                            <div className="relative flex items-center justify-center">
                                {/* วงกลมที่กระพริบ (Pulsing Effect) */}
                                <div className="absolute w-12 h-12 bg-[#4285F4] rounded-full opacity-40 animate-ping" />

                                {/* จุดสีฟ้าหลัก */}
                                <div style={{
                                    width: 24,
                                    height: 24,
                                    borderRadius: "50%",
                                    background: "#4285F4",
                                    border: "3px solid white",
                                    boxShadow: "0 0 10px rgba(66,133,244,0.8)",
                                }} className="relative z-10" />
                            </div>
                        </Marker>
                    )}
                </Map>
            </div>

            {/* --- FLOATING BUTTONS --- */}
            <div className={`transition-opacity duration-300 ${isMenuExpanded ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
                <div className="absolute top-20 right-5 z-10">
                    <button onClick={() => setIsSatellite(!isSatellite)} className="w-[55px] h-[55px] bg-white rounded-full flex items-center justify-center shadow-[0_4px_12px_rgba(0,0,0,0.1)] active:scale-95 transition">
                        {isSatellite ? <MapIcon className="text-gray-800" size={26} /> : <Layers className="text-gray-800" size={26} />}
                    </button>
                </div>
                <div
                    className="absolute top-[150px] right-5 z-10 transition-opacity duration-300"
                    style={{
                        opacity: Math.abs(mapHeading) > 1.0 ? 1 : 0,
                        pointerEvents: Math.abs(mapHeading) > 1.0 ? 'auto' : 'none'
                    }}
                >
                    <CustomCompass
                        bearing={mapHeading}
                        onTap={() => {
                            if (mapRef.current) {
                                mapRef.current.flyTo({ bearing: 0, duration: 500 });
                            }
                        }}
                    />
                </div>
                {!isCameraCentered && (
                    <div className="absolute bottom-[200px] md:bottom-10 left-5 md:left-10 z-10">
                        <button onClick={handleCenterCamera} className="flex items-center gap-2 px-[20px] py-[12px] bg-white rounded-full shadow-[0_2px_10px_rgba(0,0,0,0.1)] active:scale-95 transition">
                            <Navigation className="text-[#4285F4] w-5 h-5" />
                            <span className="text-gray-800 font-medium">ปรับจุดกลาง</span>
                        </button>
                    </div>
                )}
            </div>

            {/* 💡 3. BOTTOM SHEET (Framer Motion) */}
            <motion.div
                layout // ทำให้การเปลี่ยนความสูง (ตอนกางเมนู) มีแอนิเมชันสปริงอัตโนมัติ
                drag="y" // อนุญาตให้ใช้นิ้วลากขึ้น-ลงได้
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={0.2}
                onDragEnd={(e, info) => {
                    if (info.offset.y > 50) setIsMenuExpanded(false); // ลากลง = ปิด
                    else if (info.offset.y < -50) setIsMenuExpanded(true); // ลากขึ้น = เปิด
                }}
                className="absolute bottom-0 left-0 right-0 z-20 bg-white rounded-t-[40px] shadow-[0_-10px_40px_rgba(0,0,0,0.15)] px-6 pt-[12px] pb-[calc(2rem+env(safe-area-inset-bottom))] touch-none md:hidden"
            >
                <div className="flex flex-col items-center">
                    {/* Handle Bar */}
                    <div
                        className="w-[50px] h-[5px] bg-gray-300 rounded-full mb-6 cursor-pointer"
                        onClick={() => setIsMenuExpanded(!isMenuExpanded)}
                    ></div>

                    <AnimatePresence mode="wait">
                        {isMenuExpanded ? (
                            <motion.div
                                key="expanded-menu"
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: 20 }}
                                className="w-full flex flex-col"
                            >
                                <h3 className="text-[22px] font-bold text-center text-gray-900 mb-6">เลือกรูปแบบการนำทาง</h3>
                                <div className="flex flex-col gap-[12px]">
                                    {/* ปุ่มที่ 1: Google Maps — reuses AFE's existing handleEmergencyNav (Phase 4C-1 item 5) */}
                                    <button
                                        onClick={handleEmergencyNav}
                                        className="w-full flex items-center p-[16px] rounded-3xl bg-[#F8F9FA] active:scale-[0.98] transition"
                                    >
                                        <div className="w-[52px] h-[52px] bg-white rounded-full flex items-center justify-center shadow-[0_1px_3px_0_rgba(0,0,0,0.1),0_1px_2px_-1px_rgba(0,0,0,0.1)] border-[1px] border-solid border-[#F3F4F6] shrink-0">
                                            <img
                                                src="/google_maps.png"
                                                alt="Google Maps Icon"
                                                className="w-7 h-7 object-contain"
                                            />
                                        </div>
                                        <div className="flex-1 text-left px-[16px]">
                                            <h4 className="font-bold text-[17px] text-gray-900 leading-tight">Google Maps</h4>
                                            <p className="text-[13px] text-gray-500 font-light mt-0.5">ระบบนำทางผ่านแอปพลิเคชันมาตรฐาน</p>
                                        </div>
                                        <ChevronRight className="text-gray-400 w-5 h-5 shrink-0" />
                                    </button>

                                    {/* ปุ่มที่ 2: Web Application — reuses AFE's existing /navigation link+query (Phase 4C-1 item 5) */}
                                    <Link
                                        href={legacyNavigateHref}
                                        aria-disabled={isStartDisabled}
                                        onClick={(e) => {
                                            if (isStartDisabled) {
                                                e.preventDefault();
                                            }
                                        }}
                                        className={`w-full flex items-center p-[16px] rounded-3xl bg-[#F8F9FA] active:scale-[0.98] transition ${isStartDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    >
                                        <div className="w-[52px] h-[52px] bg-[#FFF3E0] rounded-full flex items-center justify-center shrink-0">
                                            <Globe className="text-[#FF9800] w-6 h-6" />
                                        </div>
                                        <div className="flex-1 text-left px-[16px]">
                                            <h4 className="font-bold text-[17px] text-gray-900 leading-tight">
                                                {!hasResolvedNavigationIdentity
                                                    ? 'กำลังโหลดข้อมูลผู้ใช้งาน...'
                                                    : !hasValidTargetPosition
                                                        ? 'กำลังรอตำแหน่งล่าสุด...'
                                                        : !isGpsFresh
                                                            ? 'กำลังค้นหาตำแหน่งปัจจุบัน...'
                                                            : 'Web Application'}
                                            </h4>
                                            <p className="text-[13px] text-gray-500 font-light mt-0.5">
                                                {isStartDisabled
                                                    ? 'รอข้อมูลก่อนเริ่มนำทาง'
                                                    : 'ระบบนำทางผ่านเว็บเบราว์เซอร์'}
                                            </p>
                                        </div>
                                        <ChevronRight className="text-gray-400 w-5 h-5 shrink-0" />
                                    </Link>

                                    {/* ปุ่มที่ 3: Mobile Application — opens the native Flutter app via custom scheme. */}
                                    <button
                                        type="button"
                                        onClick={handleMobileAppNative}
                                        disabled={isStartDisabled || !mobileAppNativeHref}
                                        className={`w-full flex items-center p-[16px] rounded-3xl bg-[#F8F9FA] active:scale-[0.98] transition ${(isStartDisabled || !mobileAppNativeHref) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    >
                                        <div className="w-[52px] h-[52px] bg-[#E8F0FE] rounded-full flex items-center justify-center shrink-0">
                                            <Navigation className="text-[#4285F4] w-6 h-6" />
                                        </div>
                                        <div className="flex-1 text-left px-[16px]">
                                            <h4 className="font-bold text-[17px] text-gray-900 leading-tight">Mobile Application</h4>
                                            <p className="text-[13px] text-gray-500 font-light mt-0.5">ระบบนำทางผ่านแอปพลิเคชันบนสมาร์ทโฟน</p>
                                        </div>
                                        <ChevronRight className="text-gray-400 w-5 h-5 shrink-0" />
                                    </button>
                                </div>
                            </motion.div>
                        ) : (
                            <motion.button
                                key="collapsed-btn"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                onClick={() => setIsMenuExpanded(true)}
                                disabled={!patientLocation}
                                className={`w-full flex items-center p-6 rounded-[24px] shadow-[0_10px_15px_-3px_var(--tw-shadow-color,rgba(0,0,0,0.1)),0_4px_6px_-4px_var(--tw-shadow-color,rgba(0,0,0,0.1))] transition-all active:scale-[0.98]
                                    ${patientLocation ? 'bg-[#1B5E40] shadow-[#1B5E40]/40' : 'bg-gray-400 cursor-not-allowed'}
                                `}
                            >
                                <div className="w-[52px] h-[52px] bg-white/15 rounded-full flex items-center justify-center shrink-0">
                                    <MapPin className="text-white w-7 h-7" />
                                </div>
                                <div className="flex-1 text-left px-[20px]">
                                    <h2 className="text-white text-[28px] font-bold leading-none">เริ่มนำทาง</h2>
                                </div>
                                <ChevronRight className="text-white w-6 h-6 shrink-0" />
                            </motion.button>
                        )}
                    </AnimatePresence>
                </div>
            </motion.div>

            {/* Backdrop ปิดจอสีดำ */}
            {isMenuExpanded && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute inset-0 bg-black/20 z-10 md:hidden"
                    onClick={() => setIsMenuExpanded(false)}
                />
            )}

            {/* 💡 ปุ่มวงกลมนำทางสำหรับ Desktop (โชว์เฉพาะจอใหญ่) — reuses legacyNavigateHref (Phase 4C-1 item 5) */}
            <div className="hidden md:flex absolute bottom-10 right-10 z-20">
                <Link
                    href={legacyNavigateHref}
                    aria-disabled={isStartDisabled}
                    onClick={(e) => {
                        if (isStartDisabled) {
                            e.preventDefault();
                        }
                    }}
                    className={`w-16 h-16 rounded-full flex items-center justify-center shadow-[0_4px_20px_rgba(0,0,0,0.15)] transition-all hover:scale-105 active:scale-95
                        ${!isStartDisabled ? 'bg-[#1B5E40] text-white hover:bg-[#154a32]' : 'bg-gray-400 text-gray-100 cursor-not-allowed'}
                    `}
                    title="เริ่มนำทาง" // Tooltip เวลาเอาเมาส์ชี้
                >
                    <Navigation className="w-7 h-7" />
                </Link>
            </div>
        </main>
    );
}

export default Location
