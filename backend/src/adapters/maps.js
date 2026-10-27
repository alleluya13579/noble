// Map adapters: geocode a typed address, reverse-geocode a pin. Sandbox returns the country centre
// and a generic place name so listings can still be created without a token.
import { config } from '../config.js';

export function sandboxMaps(db) {
  return {
    id: 'sandbox', live: false,
    async geocode(q, country) { const c = db.country(country); return c ? [{ label: `${q}, ${c.name}`, lat: c.center_lat, lng: c.center_lng }] : []; },
    async reverse(lat, lng, country) { const c = db.country(country); return { placeName: c ? c.name : `${lat.toFixed(3)}, ${lng.toFixed(3)}` }; }
  };
}

/* Mapbox Geocoding v6. https://docs.mapbox.com/api/search/geocoding/ */
export function mapboxMaps(c = config.maps.mapbox) {
  const base = 'https://api.mapbox.com/search/geocode/v6';
  return {
    id: 'mapbox', live: true,
    async geocode(q, country) {
      const r = await fetch(`${base}/forward?q=${encodeURIComponent(q)}&country=${country}&limit=5&access_token=${c.token}`);
      const d = await r.json(); if (!r.ok) throw new Error(`mapbox: ${d.message}`);
      return (d.features || []).map(f => ({ label: f.properties.full_address || f.properties.name, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
    },
    async reverse(lat, lng) {
      const r = await fetch(`${base}/reverse?longitude=${lng}&latitude=${lat}&types=neighborhood,locality,place&access_token=${c.token}`);
      const d = await r.json(); if (!r.ok) throw new Error(`mapbox: ${d.message}`);
      const f = d.features?.[0]; return { placeName: f ? (f.properties.name || f.properties.full_address) : `${lat.toFixed(3)}, ${lng.toFixed(3)}` };
    }
  };
}

export function mapsFor(db) { return config.maps.mapbox.configured ? mapboxMaps() : sandboxMaps(db); }
