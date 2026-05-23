import { useState, KeyboardEvent } from 'react';
import { MapPin, ChevronLeft, ChevronRight, Sparkles, Check, Loader2, RotateCcw, Building2, Mountain, Eye, Trees, Map as MapIcon, Landmark } from 'lucide-react';
import type { StopType, TourStop } from '../lib/useTour';
import { useTour } from '../lib/useTour';

const STOP_TYPE_META: Record<StopType, { label: string; Icon: typeof Building2 }> = {
  building: { label: 'Building', Icon: Building2 },
  monument: { label: 'Monument', Icon: Landmark },
  viewpoint: { label: 'Viewpoint', Icon: Eye },
  natural_feature: { label: 'Nature', Icon: Mountain },
  district: { label: 'District', Icon: MapIcon },
  other: { label: 'Stop', Icon: Trees },
};

interface TourOverlayProps {
  controller: ReturnType<typeof useTour>;
}

export function TourOverlay({ controller }: TourOverlayProps) {
  const { tour, status, error, activeIndex, isEnded, plan, reset, next, prev, goTo } = controller;
  const [area, setArea] = useState('');

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') plan(area);
  };

  // ── Empty state: ask for an area ────────────────────────────────────
  if (!tour) {
    return (
      <div className="absolute top-4 left-4 w-[320px] rounded-2xl bg-zinc-950/75 border border-zinc-800/80 backdrop-blur-md shadow-2xl p-4 z-20 pointer-events-auto">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-zinc-200 tracking-tight">Plan a Guided Tour</h2>
        </div>
        <p className="text-xs text-zinc-400 mb-3 leading-relaxed">
          Type a city, park, or campus and I'll route you through a few notable stops.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={area}
            onChange={(e) => setArea(e.target.value)}
            onKeyDown={onKey}
            placeholder="e.g. Stanford University"
            disabled={status === 'planning'}
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/60 disabled:opacity-50"
          />
          <button
            onClick={() => plan(area)}
            disabled={status === 'planning' || !area.trim()}
            className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-zinc-950 text-xs font-bold disabled:opacity-40 disabled:hover:bg-emerald-600 transition-all flex items-center gap-1.5"
          >
            {status === 'planning' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Plan'}
          </button>
        </div>
        {status === 'planning' && (
          <p className="text-[11px] text-emerald-400/80 mt-2 font-mono">Routing your stops…</p>
        )}
        {status === 'error' && error && (
          <p className="text-[11px] text-rose-400 mt-2 font-mono break-words">⚠ {error}</p>
        )}
      </div>
    );
  }

  // ── Active itinerary ───────────────────────────────────────────────
  const total = tour.stops.length;
  const visitedCount = isEnded ? total : Math.max(0, activeIndex);
  const progress = total > 0 ? Math.min(100, (visitedCount / total) * 100) : 0;

  return (
    <div className="absolute top-4 left-4 w-[340px] max-h-[calc(100%-2rem)] rounded-2xl bg-zinc-950/75 border border-zinc-800/80 backdrop-blur-md shadow-2xl flex flex-col z-20 pointer-events-auto">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-zinc-800/60">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-zinc-100 tracking-tight truncate">{tour.tour_title}</h2>
            <p className="text-[11px] text-zinc-500 font-mono mt-0.5 truncate">
              {tour.area} · {total} stops
            </p>
          </div>
          <button
            onClick={reset}
            title="Plan a different tour"
            className="shrink-0 h-7 w-7 rounded-lg border border-zinc-800 hover:border-emerald-500/50 text-zinc-400 hover:text-emerald-400 flex items-center justify-center transition-all"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Stop cards */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
        {tour.stops.map((stop, i) => {
          const state: StopState = isEnded
            ? 'visited'
            : i < activeIndex
            ? 'visited'
            : i === activeIndex
            ? 'active'
            : 'upcoming';
          return (
            <StopCard
              key={stop.order}
              stop={stop}
              state={state}
              onClick={() => goTo(i)}
            />
          );
        })}
        {isEnded && (
          <div className="mt-3 p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 text-[11px] text-emerald-300 text-center font-medium">
            🎉 Tour complete — click any stop to revisit.
          </div>
        )}
      </div>

      {/* Footer: progress + controls */}
      <div className="px-4 pt-3 pb-3 border-t border-zinc-800/60">
        <div className="h-1 rounded-full bg-zinc-800 overflow-hidden mb-3">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={prev}
            disabled={activeIndex <= 0}
            className="px-3 py-1.5 rounded-lg border border-zinc-800 hover:border-emerald-500/50 text-zinc-300 text-xs font-medium disabled:opacity-40 disabled:hover:border-zinc-800 transition-all flex items-center gap-1"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </button>
          <span className="text-[11px] text-zinc-500 font-mono">
            {isEnded ? `${total} / ${total}` : `${Math.max(1, activeIndex + 1)} / ${total}`}
          </span>
          <button
            onClick={next}
            disabled={isEnded}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-zinc-950 text-xs font-bold disabled:opacity-40 disabled:hover:bg-emerald-600 transition-all flex items-center gap-1"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

type StopState = 'visited' | 'active' | 'upcoming';

function StopCard({ stop, state, onClick }: { stop: TourStop; state: StopState; onClick: () => void }) {
  const { Icon, label } = STOP_TYPE_META[stop.stop_type] || STOP_TYPE_META.other;

  const containerCls =
    state === 'active'
      ? 'border-emerald-500/60 bg-emerald-500/5 shadow-lg shadow-emerald-500/10'
      : state === 'visited'
      ? 'border-zinc-800/60 bg-zinc-900/40 opacity-80'
      : 'border-zinc-800/60 bg-zinc-900/30 opacity-60';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl border px-3 py-2.5 transition-all hover:opacity-100 hover:border-emerald-500/40 ${containerCls}`}
    >
      <div className="flex items-start gap-2.5">
        {/* Indicator */}
        <div className="relative shrink-0 mt-0.5">
          {state === 'visited' ? (
            <div className="h-6 w-6 rounded-full bg-emerald-500 flex items-center justify-center">
              <Check className="h-3.5 w-3.5 text-zinc-950" strokeWidth={3} />
            </div>
          ) : state === 'active' ? (
            <div className="relative h-6 w-6 rounded-full bg-emerald-500 flex items-center justify-center text-[11px] font-extrabold text-zinc-950">
              {stop.order}
              <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-60" />
            </div>
          ) : (
            <div className="h-6 w-6 rounded-full border border-zinc-700 bg-zinc-900 flex items-center justify-center text-[11px] font-bold text-zinc-500">
              {stop.order}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-semibold truncate ${state === 'active' ? 'text-zinc-100' : 'text-zinc-300'}`}>
              {stop.name}
            </span>
          </div>
          <div className="flex items-center gap-1 mt-0.5 text-[10px] font-mono text-zinc-500">
            <Icon className="h-3 w-3" />
            <span>{label}</span>
            <span className="text-zinc-700">·</span>
            <span>{stop.duration_sec}s</span>
          </div>
          <p className={`text-[11px] mt-1 leading-snug ${state === 'active' ? 'text-zinc-300' : 'text-zinc-500'}`}>
            <MapPin className="h-2.5 w-2.5 inline mr-1 -mt-0.5 text-zinc-600" />
            {stop.look_for}
          </p>
        </div>
      </div>
    </button>
  );
}
