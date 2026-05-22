import { useEffect, useRef, useState } from 'react';
import { resolveMapsApiKey } from '../lib/map_tools';

let mapsApiConfigured = false;

export function StreetWalkPanorama() {
  const containerRef = useRef<HTMLDivElement>(null);
  const panoramaRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const [errorInfo, setErrorInfo] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (window as any)._vistaStreetWalkContext = (window as any)._vistaStreetWalkContext || {};

    const container = containerRef.current;
    if (!container) return;

    const initMap = async () => {
      try {
        const { setOptions, importLibrary } = await import('@googlemaps/js-api-loader');
        if (!mounted) return;

        const apiKey = await resolveMapsApiKey();
        if (!apiKey) {
          setErrorInfo('Missing Google Maps API key (VITE_GOOGLE_MAPS_API_KEY). Check environment variables.');
          return;
        }

        if (!mapsApiConfigured) {
          console.log('[TourGuide] Configuring Google Maps API...');
          setOptions({ key: apiKey, v: 'weekly' });
          mapsApiConfigured = true;
        }

        const streetViewLib = await importLibrary('streetView');
        if (!mounted || !streetViewLib || !containerRef.current) {
          console.log('[TourGuide] Street View init cancelled: mounted=', mounted, 'lib=', !!streetViewLib, 'container=', !!containerRef.current);
          return;
        }

        const SV = new google.maps.StreetViewService();
        const defaultPos = { lat: 40.758, lng: -73.9855 }; // Times Square default

        // Find the nearest official Google panorama (not user-contributed photospheres)
        SV.getPanorama({
          location: defaultPos,
          radius: 100,
          source: google.maps.StreetViewSource.GOOGLE,
        }).then(({ data }) => {
          if (!mounted || !containerRef.current) {
            console.log('[TourGuide] Panorama source found, but component unmounted');
            return;
          }

          const StreetViewPanoramaCtor = (streetViewLib as any).StreetViewPanorama;
          const pano = new StreetViewPanoramaCtor(containerRef.current, {
            pano: data.location!.pano!,
            pov: { heading: 165, pitch: 0 },
            zoom: 1,
            addressControl: false,
            showRoadLabels: false,
          });

          panoramaRef.current = pano;
          (window as any)._vistaStreetWalkContext.panorama = pano;

          pano.addListener('status_changed', () => {
            if (pano.getStatus() === 'ZERO_RESULTS') {
              setErrorInfo('No Street View available at this location.');
            }
          });

          // Ensure tiles render even if container was laid out after init
          requestAnimationFrame(() => {
            if (mounted && panoramaRef.current) {
              google.maps.event.trigger(panoramaRef.current, 'resize');
            }
          });
        }).catch((err) => {
          if (!mounted) return;
          console.warn('[TourGuide] GOOGLE source panorama failed, trying fallback:', err);
          
          if (!containerRef.current) return;
          
          const StreetViewPanoramaCtor = (streetViewLib as any).StreetViewPanorama;
          const pano = new StreetViewPanoramaCtor(containerRef.current, {
            position: defaultPos,
            pov: { heading: 165, pitch: 0 },
            zoom: 1,
            addressControl: false,
            showRoadLabels: false,
          });
          
          panoramaRef.current = pano;
          (window as any)._vistaStreetWalkContext.panorama = pano;
        });
      } catch (err: any) {
        if (!mounted) return;
        console.error('[TourGuide] Failed to load Street View:', err);
        setErrorInfo(`Failed to load Maps API: ${err.message || err}`);
      }
    };

    initMap();

    return () => {
      console.log('[TourGuide] StreetWalkPanorama cleaning up...');
      mounted = false;
      if (panoramaRef.current) {
        google.maps.event.clearInstanceListeners(panoramaRef.current);
        panoramaRef.current = null;
      }
      if ((window as any)._vistaStreetWalkContext) {
        (window as any)._vistaStreetWalkContext.panorama = null;
      }
    };
  }, []);

  return (
    <div className="absolute inset-0 h-full w-full bg-zinc-900">
      {errorInfo ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-lg rounded-2xl border border-red-500/40 bg-red-500/15 p-6 text-center text-red-100 shadow-2xl backdrop-blur-md">
            <h2 className="mb-2 text-xl font-semibold">Street View Cannot Load</h2>
            <p className="font-mono text-sm opacity-90">{errorInfo}</p>
          </div>
        </div>
      ) : (
        <div ref={containerRef} className="absolute inset-0 h-full w-full" />
      )}
      <div className="pointer-events-none absolute inset-0 border-4 border-emerald-500/20 shadow-inner" />
    </div>
  );
}
