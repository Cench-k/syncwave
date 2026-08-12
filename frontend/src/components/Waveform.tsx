"use client";
import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.js";
import MinimapPlugin from "wavesurfer.js/dist/plugins/minimap.js";
import { Block } from "@/lib/types";

interface Props {
  audioUrl: string;
  blocks: Block[];
  activeIndex: number | null;
  onReady: (durationSec: number) => void;
  onTimeUpdate: (t: number) => void;
  onRegionEdit: (index: number, start: number, end: number) => void;
  onRegionClick: (index: number) => void;
  registerControls?: (controls: WaveControls) => void;
}

export interface WaveControls {
  playPause: () => void;
  isPlaying: () => boolean;
  seek: (sec: number) => void;
  setRate: (r: number) => void;
  playRegion: (start: number, end: number) => void;
}

type RegionsAPI = ReturnType<typeof RegionsPlugin.create>;
type RegionHandle = ReturnType<RegionsAPI["addRegion"]>;

const REGION_IDLE = "rgba(94,234,212,0.12)";
const REGION_ACTIVE = "rgba(94,234,212,0.30)";

export default function Waveform({
  audioUrl,
  blocks,
  activeIndex,
  onReady,
  onTimeUpdate,
  onRegionEdit,
  onRegionClick,
  registerControls,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsAPI | null>(null);
  const regionMapRef = useRef(new Map<number, RegionHandle>());
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  // Regions positioned before the audio is decoded land against a zero
  // duration, so hold them back until wavesurfer reports ready.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "#3a4150",
      progressColor: "#5eead4",
      cursorColor: "#f5f5f5",
      barWidth: 2,
      barRadius: 2,
      barGap: 1,
      height: 120,
      url: audioUrl,
      plugins: [
        regions,
        TimelinePlugin.create({ height: 18 }),
        MinimapPlugin.create({
          height: 30,
          waveColor: "#2a2f38",
          progressColor: "#0d9488",
        }),
      ],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    setReady(false);
    ws.on("ready", () => {
      setReady(true);
      onReady(ws.getDuration());
    });
    ws.on("timeupdate", (t) => onTimeUpdate(t));
    ws.on("error", (e) => console.error("[Waveform] load failed", e));

    regions.on("region-updated", (region) => {
      const idx = Number(region.id);
      if (!Number.isNaN(idx)) onRegionEdit(idx, region.start, region.end);
    });
    regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      const idx = Number(region.id);
      if (!Number.isNaN(idx)) onRegionClick(idx);
    });

    if (registerControls) {
      registerControls({
        playPause: () => ws.playPause(),
        isPlaying: () => ws.isPlaying(),
        seek: (sec) => {
          const d = ws.getDuration();
          if (d > 0) ws.seekTo(Math.max(0, Math.min(sec, d)) / d);
        },
        setRate: (r) => ws.setPlaybackRate(r),
        playRegion: (start, end) => {
          const d = ws.getDuration();
          if (d <= 0) return;
          ws.setTime(start);
          const stop = (t: number) => {
            if (t >= end) {
              ws.pause();
              ws.un("timeupdate", stop);
            }
          };
          ws.on("timeupdate", stop);
          ws.play();
        },
      });
    }

    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      regionMapRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  // Rebuild regions when the block geometry changes.
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !ready) return;
    regions.clearRegions();
    const map = new Map<number, RegionHandle>();
    for (const b of blocks) {
      map.set(
        b.index,
        regions.addRegion({
          id: String(b.index),
          start: b.start,
          end: b.end,
          color: b.index === activeIndex ? REGION_ACTIVE : REGION_IDLE,
          drag: true,
          resize: true,
          content: String(b.index + 1),
        })
      );
    }
    regionMapRef.current = map;
    // activeIndex is intentionally omitted: it changes on every timeupdate,
    // and tearing down every region several times a second made the waveform
    // unusable during playback. Highlighting is handled below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, ready]);

  // Recolour only the regions whose highlight state actually changed.
  const prevActiveRef = useRef<number | null>(null);
  useEffect(() => {
    const map = regionMapRef.current;
    const paint = (idx: number | null, color: string) => {
      if (idx === null) return;
      const region = map.get(idx);
      const block = blocksRef.current.find((b) => b.index === idx);
      if (region && block) {
        region.setOptions({ start: block.start, end: block.end, color });
      }
    };
    if (prevActiveRef.current !== activeIndex) {
      paint(prevActiveRef.current, REGION_IDLE);
      paint(activeIndex, REGION_ACTIVE);
      prevActiveRef.current = activeIndex;
    }
  }, [activeIndex, blocks]);

  return <div ref={containerRef} className="w-full" />;
}
