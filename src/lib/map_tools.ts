export interface MapPanorama {
  getPov(): { heading: number; pitch: number };
  setPov(pov: { heading: number; pitch: number }): void;
  getLinks(): Array<{ heading: number; pano: string }> | null;
  setPano(pano: string): void;
  setPosition(latLng: any): void;
}

export interface Geocoder {
  geocode(request: { address: string }, callback: (results: any[], status: string) => void): void;
}

export interface StreetViewService {
  getPanorama(request: { location: any; radius: number }, callback: (data: any, status: string) => void): void;
}

/**
 * Calculates the best pano link to move in a given direction.
 */
export function findBestLink(links: any[], currentHeading: number, targetOffset: number): any | null {
  if (!links || links.length === 0) return null;
  
  let bestLink = links[0];
  let minDiff = 360;
  const targetHeading = (currentHeading + targetOffset + 360) % 360;
  
  for (const link of links) {
    const diff = Math.abs((link.heading - targetHeading + 180) % 360 - 180);
    if (diff < minDiff) {
      minDiff = diff;
      bestLink = link;
    }
  }
  return bestLink;
}

/**
 * Handles navigation (left, right, forward, backward, around).
 */
export function handleNavigate(direction: string, panorama: MapPanorama): { status: string; action?: string; message?: string } {
  const pov = panorama.getPov();
  const dir = direction.toLowerCase();

  if (dir === 'left') {
    panorama.setPov({ heading: (pov.heading - 45 + 360) % 360, pitch: pov.pitch });
    return { status: 'success', action: 'Turned left' };
  } else if (dir === 'right') {
    panorama.setPov({ heading: (pov.heading + 45) % 360, pitch: pov.pitch });
    return { status: 'success', action: 'Turned right' };
  } else if (dir === 'around') {
    panorama.setPov({ heading: (pov.heading + 180) % 360, pitch: pov.pitch });
    return { status: 'success', action: 'Turned around' };
  }

  const links = panorama.getLinks();
  if (!links || links.length === 0) {
    return { status: 'error', message: `Dead end. No ${dir} path available.` };
  }

  let bestLink = null;
  if (dir === 'forward' || dir === 'straight') {
    bestLink = findBestLink(links, pov.heading, 0);
  } else if (dir === 'backward') {
    bestLink = findBestLink(links, pov.heading, 180);
  }

  if (bestLink) {
    panorama.setPano(bestLink.pano);
    return { status: 'success', action: `Moved ${dir}` };
  }

  return { status: 'error', message: `Unknown direction: ${direction}` };
}

/**
 * Handles teleportation using geocoding and Street View service.
 */
export async function handleTeleport(
  location: string, 
  panorama: MapPanorama, 
  geocoder: Geocoder, 
  svService: StreetViewService
): Promise<{ status: string; location?: string; details?: string; message?: string }> {
  try {
    const geoResult = await new Promise<any>((resolve, reject) => {
      geocoder.geocode({ address: location }, (results, status) => {
        if (status === 'OK' && results?.[0]) resolve(results[0].geometry.location);
        else reject(new Error('Geocoding failed'));
      });
    });

    const svResult = await new Promise<any>((resolve, reject) => {
      svService.getPanorama({ location: geoResult, radius: 500 }, (data, status) => {
        if (status === 'OK' && data) resolve(data);
        else reject(new Error('No Street View found near this location'));
      });
    });

    panorama.setPosition(svResult.location.latLng);
    return { status: 'success', location, details: 'Teleported successfully.' };
  } catch (err: any) {
    return { status: 'error', message: err.message || String(err) };
  }
}

// Singleton cache for the runtime API key
let runtimeMapsApiKey: string | null = null;

/**
 * Resolves the Google Maps API key from build-time environment variables,
 * cached runtime keys, or by fetching from the /api/config endpoint.
 */
export async function resolveMapsApiKey(): Promise<string> {
  // 1. Try build-time env var
  let apiKey = (import.meta as any).env.VITE_GOOGLE_MAPS_API_KEY || '';
  
  // 2. Try cached runtime key
  if (!apiKey && runtimeMapsApiKey) {
    apiKey = runtimeMapsApiKey;
  }

  // 3. Fetch from backend if still missing
  if (!apiKey) {
    try {
      console.log('[TourGuide] Maps API Key missing in build. Fetching from runtime backend...');
      const resp = await fetch('/api/config');
      if (resp.ok) {
        const data = await resp.json();
        apiKey = data.VITE_GOOGLE_MAPS_API_KEY || '';
        runtimeMapsApiKey = apiKey; // Cache it
      }
    } catch (err) {
      console.error('[TourGuide] Failed to fetch runtime config:', err);
    }
  }

  return apiKey;
}
