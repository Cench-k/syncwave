"use client";
import { useEffect, useRef } from "react";
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
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

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

    ws.on("ready", () => onReady(ws.getDuration()));
    ws.on("timeupdate", (t) => onTimeUpdate(t));

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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  // Sync regions whenever blocks change
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions) return;
    regions.clearRegions();
    for (const b of blocks) {
      const isActive = activeIndex === b.index;
      regions.addRegion({
        id: String(b.index),
        start: b.start,
        end: b.end,
        color: isActive ? "rgba(94,234,212,0.30)" : "rgba(94,234,212,0.12)",
        drag: true,
        resize: true,
        content: String(b.index + 1),
      });
    }
  }, [blocks, activeIndex]);

  return <div ref={containerRef} className="w-full" />;
}
