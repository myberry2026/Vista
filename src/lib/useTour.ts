import { useCallback, useMemo, useState } from 'react';

export type StopType = 'building' | 'monument' | 'viewpoint' | 'natural_feature' | 'district' | 'other';

export interface TourStop {
  order: number;
  name: string;
  stop_type: StopType;
  map_query: string;
  narration: string;
  look_for: string;
  duration_sec: number;
}

export interface Tour {
  intent: 'guided_tour';
  area: string;
  tour_title: string;
  stops: TourStop[];
}

export type TourStatus = 'idle' | 'planning' | 'ready' | 'error';

/**
 * Drives the planner → state machine portion of the guided tour.
 *
 * - `plan(area)`: hit /api/plan-tour and store the itinerary
 * - active index management: start / next / prev / goTo / reset
 *
 * No map flight, no Live narration — those will be layered on next.
 */
export function useTour() {
  const [tour, setTour] = useState<Tour | null>(null);
  const [status, setStatus] = useState<TourStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  /** -1 = not started, 0..n-1 = active, n = ended */
  const [activeIndex, setActiveIndex] = useState<number>(-1);

  const plan = useCallback(async (area: string) => {
    const cleaned = area.trim();
    if (!cleaned) return;
    setStatus('planning');
    setError(null);
    setTour(null);
    setActiveIndex(-1);
    try {
      const res = await fetch('/api/plan-tour', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ area: cleaned }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || `HTTP ${res.status}`);
        setStatus('error');
        return;
      }
      setTour(data as Tour);
      setStatus('ready');
      setActiveIndex(0); // auto-start at the first stop
    } catch (e: any) {
      setError(e?.message || String(e));
      setStatus('error');
    }
  }, []);

  const reset = useCallback(() => {
    setTour(null);
    setStatus('idle');
    setError(null);
    setActiveIndex(-1);
  }, []);

  const start = useCallback(() => {
    if (!tour || !tour.stops.length) return;
    setActiveIndex(0);
  }, [tour]);

  const next = useCallback(() => {
    if (!tour) return;
    setActiveIndex(i => Math.min(i + 1, tour.stops.length));
  }, [tour]);

  const prev = useCallback(() => {
    if (!tour) return;
    setActiveIndex(i => {
      if (i >= tour.stops.length) return tour.stops.length - 1; // coming back from ended
      return Math.max(0, i - 1);
    });
  }, [tour]);

  const goTo = useCallback((i: number) => {
    if (!tour) return;
    if (i < 0 || i >= tour.stops.length) return;
    setActiveIndex(i);
  }, [tour]);

  const activeStop = useMemo<TourStop | null>(() => {
    if (!tour) return null;
    if (activeIndex < 0 || activeIndex >= tour.stops.length) return null;
    return tour.stops[activeIndex];
  }, [tour, activeIndex]);

  const isEnded = !!tour && activeIndex >= tour.stops.length;

  return {
    tour,
    status,
    error,
    activeIndex,
    activeStop,
    isEnded,
    plan,
    reset,
    start,
    next,
    prev,
    goTo,
  };
}
