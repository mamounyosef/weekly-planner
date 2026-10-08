import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Maximize2,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { AgentTheme } from './AgentCards';

export interface PreviewImageItem {
  url: string;
  name: string;
  localId?: string; // composer pending attachment
  id?: string;      // sent attachment id
}

interface ImagePreviewModalProps {
  items: PreviewImageItem[];
  initialIndex: number;
  onClose: () => void;
  onRemove?: (localId: string) => void;
  theme: AgentTheme;
}

export function ImagePreviewModal({
  items,
  initialIndex,
  onClose,
  onRemove,
  theme,
}: ImagePreviewModalProps) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(initialIndex, items.length - 1)));
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync index if items change or initialIndex changes
  useEffect(() => {
    if (items.length === 0) {
      onClose();
      return;
    }
    if (index >= items.length) {
      setIndex(items.length - 1);
    }
  }, [items.length, index, onClose]);

  // Reset zoom and pan when switching images
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [index]);

  const currentItem = items[index];

  const handlePrev = useCallback(() => {
    if (items.length <= 1) return;
    setIndex(i => (i > 0 ? i - 1 : items.length - 1));
  }, [items.length]);

  const handleNext = useCallback(() => {
    if (items.length <= 1) return;
    setIndex(i => (i < items.length - 1 ? i + 1 : 0));
  }, [items.length]);

  const handleZoomIn = useCallback(() => {
    setZoom(z => Math.min(4, +(z + 0.5).toFixed(1)));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom(z => {
      const next = Math.max(1, +(z - 0.5).toFixed(1));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const handleResetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleToggleZoom = useCallback((e: React.MouseEvent) => {
    // If was dragging, do not toggle zoom
    if (dragStartRef.current && (Math.abs(pan.x - dragStartRef.current.panX) > 5 || Math.abs(pan.y - dragStartRef.current.panY) > 5)) {
      return;
    }
    if (zoom > 1) {
      handleResetZoom();
    } else {
      setZoom(2.2);
    }
  }, [zoom, pan, handleResetZoom]);

  // Keyboard navigation & controls
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNext();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        handleZoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        handleZoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        handleResetZoom();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onClose, handlePrev, handleNext, handleZoomIn, handleZoomOut, handleResetZoom]);

  // Mouse wheel zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      setZoom(z => Math.min(4, +(z + 0.25).toFixed(2)));
    } else {
      setZoom(z => {
        const next = Math.max(1, +(z - 0.25).toFixed(2));
        if (next === 1) setPan({ x: 0, y: 0 });
        return next;
      });
    }
  };

  // Dragging to pan when zoomed
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1 || e.button !== 0) return;
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPan({
      x: dragStartRef.current.panX + dx,
      y: dragStartRef.current.panY + dy,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleRemove = () => {
    if (!currentItem?.localId || !onRemove) return;
    const toRemoveId = currentItem.localId;
    if (items.length <= 1) {
      onRemove(toRemoveId);
      onClose();
    } else {
      onRemove(toRemoveId);
    }
  };

  if (!currentItem) return null;

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      className="fixed inset-0 z-[99999] flex flex-col items-center justify-between select-none animate-in fade-in duration-200"
      style={{
        backgroundColor: 'rgba(5, 7, 12, 0.88)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
      }}
      onClick={(e) => {
        // Exit if clicked on backdrop
        if (e.target === containerRef.current) {
          onClose();
        }
      }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
    >
      {/* Top Header Bar */}
      <div
        className="w-full flex items-center justify-between px-4 py-3 z-20 flex-shrink-0"
        style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0) 100%)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: filename & counter */}
        <div className="flex items-center gap-3 min-w-0 pr-4">
          <div className="text-white text-[13.5px] font-medium truncate max-w-[280px] md:max-w-[480px]" title={currentItem.name}>
            {currentItem.name}
          </div>
          {items.length > 1 && (
            <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-white/15 text-white/90">
              {index + 1} / {items.length}
            </span>
          )}
        </div>

        {/* Center/Right: Zoom controls & Actions */}
        <div className="flex items-center gap-1.5 md:gap-2">
          {/* Zoom controls */}
          <div className="flex items-center bg-white/10 rounded-full px-1.5 py-0.5 border border-white/10">
            <button
              type="button"
              onClick={handleZoomOut}
              disabled={zoom <= 1}
              title="Zoom out (-)"
              className="p-1 rounded-full text-white/80 hover:text-white hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            >
              <ZoomOut size={16} />
            </button>
            <button
              type="button"
              onClick={handleResetZoom}
              title="Reset zoom (0)"
              className="px-2 py-0.5 text-[11.5px] font-mono text-white/90 hover:text-white hover:bg-white/15 rounded transition-colors"
            >
              {zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`}
            </button>
            <button
              type="button"
              onClick={handleZoomIn}
              disabled={zoom >= 4}
              title="Zoom in (+)"
              className="p-1 rounded-full text-white/80 hover:text-white hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            >
              <ZoomIn size={16} />
            </button>
          </div>

          {/* Open full resolution */}
          <a
            href={currentItem.url}
            target="_blank"
            rel="noreferrer"
            title="Open in new tab"
            className="p-2 rounded-full text-white/80 hover:text-white hover:bg-white/15 transition-colors"
          >
            <ExternalLink size={17} />
          </a>

          {/* Remove button if previewing from composer */}
          {currentItem.localId && onRemove && (
            <button
              type="button"
              onClick={handleRemove}
              title="Remove this image"
              className="p-2 rounded-full text-red-400 hover:text-red-300 hover:bg-red-500/20 transition-colors"
            >
              <Trash2 size={17} />
            </button>
          )}

          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="p-2 rounded-full text-white/90 hover:text-white hover:bg-white/20 transition-colors ml-1"
          >
            <X size={20} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {/* Main Image Stage */}
      <div
        className="relative flex-1 w-full flex items-center justify-center overflow-hidden px-4 py-2 cursor-default"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            onClose();
          }
        }}
      >
        {/* Previous Arrow */}
        {items.length > 1 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handlePrev(); }}
            title="Previous image (Left arrow)"
            className="absolute left-4 top-1/2 -translate-y-1/2 z-30 p-2.5 rounded-full bg-black/50 text-white/90 hover:text-white hover:bg-black/75 border border-white/15 transition-all hover:scale-105 active:scale-95"
          >
            <ChevronLeft size={24} />
          </button>
        )}

        {/* The Image Itself */}
        <div
          className="relative max-w-full max-h-full flex items-center justify-center transition-transform duration-100 ease-out"
          style={{
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0px) scale(${zoom})`,
            cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in',
          }}
          onMouseDown={handleMouseDown}
          onClick={handleToggleZoom}
        >
          <img
            src={currentItem.url}
            alt={currentItem.name}
            draggable={false}
            className="max-w-[90vw] max-h-[76vh] md:max-h-[80vh] object-contain rounded-lg shadow-2xl pointer-events-auto"
            style={{
              boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
            }}
          />
        </div>

        {/* Next Arrow */}
        {items.length > 1 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleNext(); }}
            title="Next image (Right arrow)"
            className="absolute right-4 top-1/2 -translate-y-1/2 z-30 p-2.5 rounded-full bg-black/50 text-white/90 hover:text-white hover:bg-black/75 border border-white/15 transition-all hover:scale-105 active:scale-95"
          >
            <ChevronRight size={24} />
          </button>
        )}
      </div>

      {/* Bottom Thumbnail Strip (if multiple items) */}
      {items.length > 1 ? (
        <div
          className="w-full flex items-center justify-center py-3 px-4 z-20 flex-shrink-0"
          style={{
            background: 'linear-gradient(to top, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0) 100%)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 max-w-full overflow-x-auto py-1 px-2 scrollbar-none">
            {items.map((it, idx) => (
              <button
                key={it.localId ?? it.id ?? idx}
                type="button"
                onClick={() => setIndex(idx)}
                title={it.name}
                className="relative rounded-lg overflow-hidden flex-shrink-0 transition-all"
                style={{
                  width: 48,
                  height: 48,
                  outline: idx === index ? `2px solid ${theme.accent || '#38bdf8'}` : '1px solid rgba(255,255,255,0.2)',
                  outlineOffset: idx === index ? '2px' : '0px',
                  opacity: idx === index ? 1 : 0.6,
                  transform: idx === index ? 'scale(1.05)' : 'scale(1)',
                }}
              >
                <img src={it.url} alt={it.name} className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        </div>
      ) : (
        /* Single item footer hint */
        <div className="py-2.5 text-center text-white/40 text-[11px] z-20 flex-shrink-0 pointer-events-none">
          Click image or scroll to zoom &bull; Click outside or press Esc to close
        </div>
      )}
    </div>,
    document.body
  );
}
