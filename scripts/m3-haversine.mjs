#!/usr/bin/env node
// Independent offline Haversine helper for M3 (Route-to-Target Reference
// Location Discrepancy). Does not import navigation runtime code so it stays
// usable standalone against exported JSONL/manifest files.
//
// Internal points use { lat, lng } — never the GeoJSON [lng, lat] order.

export const EARTH_RADIUS_M = 6_371_000;

export function isValidLatLng(point) {
  if (!point || typeof point !== 'object') return false;
  const { lat, lng } = point;
  return (
    typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @returns {number} meters
 */
export function haversineMeters(a, b) {
  if (!isValidLatLng(a) || !isValidLatLng(b)) {
    throw new Error('haversineMeters: invalid coordinate input');
  }

  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);

  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  let sinA = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  sinA = Math.min(1, Math.max(0, sinA)); // clamp before asin per protocol

  return EARTH_RADIUS_M * 2 * Math.asin(Math.sqrt(sinA));
}
