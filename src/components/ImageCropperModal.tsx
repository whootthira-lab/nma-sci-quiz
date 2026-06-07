'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { X, ZoomIn, ZoomOut, Crop } from 'lucide-react';

interface ImageCropperModalProps {
  imageSrc: string;
  aspectRatio: string; // '16:9' | '9:16' | '1:1'
  onCrop: (croppedFile: File, croppedDataUrl: string) => void;
  onClose: () => void;
}

export default function ImageCropperModal({
  imageSrc,
  aspectRatio,
  onCrop,
  onClose,
}: ImageCropperModalProps) {
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0, naturalWidth: 0, naturalHeight: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [isReady, setIsReady] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);

  // Parse Aspect Ratio
  const getAspectValue = useCallback(() => {
    if (aspectRatio === '16:9') return 16 / 9;
    if (aspectRatio === '9:16') return 9 / 16;
    return 1; // 1:1
  }, [aspectRatio]);

  // Handle setting up viewport and image fit
  useEffect(() => {
    if (!imageSrc) return;

    const img = new Image();
    img.src = imageSrc;
    img.onload = () => {
      const naturalWidth = img.naturalWidth;
      const naturalHeight = img.naturalHeight;
      const imageAr = naturalWidth / naturalHeight;
      const targetAr = getAspectValue();

      // Configure Viewport Sizes (fit nicely in max 400x400 container)
      let vw = 320;
      let vh = 320;

      if (targetAr >= 1) {
        // Landscape or square
        vw = Math.min(360, window.innerWidth - 40);
        vh = vw / targetAr;
      } else {
        // Portrait
        vh = Math.min(360, window.innerHeight - 250);
        vw = vh * targetAr;
      }

      setViewportSize({ width: vw, height: vh });

      // Calculate fitted size of the image to cover viewport
      let fitWidth = 0;
      let fitHeight = 0;

      if (imageAr > targetAr) {
        // Image is wider than target aspect ratio
        fitHeight = vh;
        fitWidth = vh * imageAr;
      } else {
        // Image is taller than target aspect ratio
        fitWidth = vw;
        fitHeight = vw / imageAr;
      }

      setImageSize({
        width: fitWidth,
        height: fitHeight,
        naturalWidth,
        naturalHeight,
      });

      setPosition({ x: 0, y: 0 });
      setZoom(1);
      setIsReady(true);
    };
  }, [imageSrc, getAspectValue]);

  // Pointer Down
  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    if (!isReady) return;
    isDraggingRef.current = true;
    dragStartRef.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
    if (imageRef.current) {
      imageRef.current.setPointerCapture(e.pointerId);
    }
  };

  // Pointer Move
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current || !isReady) return;

    const newX = e.clientX - dragStartRef.current.x;
    const newY = e.clientY - dragStartRef.current.y;

    // Calculate drag limits
    const currentW = imageSize.width * zoom;
    const currentH = imageSize.height * zoom;

    const minX = -(currentW - viewportSize.width) / 2;
    const maxX = (currentW - viewportSize.width) / 2;
    const minY = -(currentH - viewportSize.height) / 2;
    const maxY = (currentH - viewportSize.height) / 2;

    setPosition({
      x: Math.max(minX, Math.min(maxX, newX)),
      y: Math.max(minY, Math.min(maxY, newY)),
    });
  };

  // Pointer Up
  const handlePointerUp = (e: React.PointerEvent) => {
    isDraggingRef.current = false;
    if (imageRef.current) {
      imageRef.current.releasePointerCapture(e.pointerId);
    }
  };

  // Ensure image stays inside boundary when zoom changes
  const handleZoomChange = (newZoom: number) => {
    setZoom(newZoom);

    const currentW = imageSize.width * newZoom;
    const currentH = imageSize.height * newZoom;

    const minX = -(currentW - viewportSize.width) / 2;
    const maxX = (currentW - viewportSize.width) / 2;
    const minY = -(currentH - viewportSize.height) / 2;
    const maxY = (currentH - viewportSize.height) / 2;

    setPosition((prev) => ({
      x: Math.max(minX, Math.min(maxX, prev.x)),
      y: Math.max(minY, Math.min(maxY, prev.y)),
    }));
  };

  // Execute Crop using HTML5 Canvas
  const handleCrop = () => {
    if (!isReady || !imageRef.current) return;

    const img = imageRef.current;
    const w = imageSize.width * zoom;
    const h = imageSize.height * zoom;

    // Scale factor from image natural pixels to screen pixels
    const scaleFactor = w / imageSize.naturalWidth;

    const imgLeft = (viewportSize.width - w) / 2 + position.x;
    const imgTop = (viewportSize.height - h) / 2 + position.y;

    // Source rect on natural image
    let sx = -imgLeft / scaleFactor;
    let sy = -imgTop / scaleFactor;
    let sw = viewportSize.width / scaleFactor;
    let sh = viewportSize.height / scaleFactor;

    // Safety bounds clamping
    sx = Math.max(0, Math.min(imageSize.naturalWidth - sw, sx));
    sy = Math.max(0, Math.min(imageSize.naturalHeight - sh, sy));
    sw = Math.min(imageSize.naturalWidth - sx, sw);
    sh = Math.min(imageSize.naturalHeight - sy, sh);

    // Target dimensions
    let cw = 1024;
    let ch = 1024;
    if (aspectRatio === '16:9') {
      cw = 1280;
      ch = 720;
    } else if (aspectRatio === '9:16') {
      cw = 720;
      ch = 1280;
    }

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');

    if (!ctx) return;

    // Draw image to canvas
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);

    // Convert canvas to Blob
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const croppedFile = new File([blob], 'cropped_image.jpg', {
          type: 'image/jpeg',
          lastModified: Date.now(),
        });
        const croppedUrl = URL.createObjectURL(blob);
        onCrop(croppedFile, croppedUrl);
      },
      'image/jpeg',
      0.92
    );
  };

  return (
    <div className="fixed inset-0 z-[150] flex flex-col items-center justify-center bg-black/90 backdrop-blur-md p-4 select-none">
      <div className="w-full max-w-md bg-[#16161a] border border-white/10 rounded-2xl overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div>
            <h3 className="text-md font-semibold text-white font-thai">ปรับแต่งและครอปรูปภาพ</h3>
            <p className="text-xs text-gray-400 font-thai">
              อัตราส่วนที่เหมาะสม: {aspectRatio}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Cropping Area */}
        <div className="flex-1 min-h-[360px] flex items-center justify-center p-6 bg-[#0a0a0c]">
          {isReady ? (
            <div
              ref={containerRef}
              className="relative border-2 border-[#D4AF37] shadow-xl overflow-hidden bg-black/50"
              style={{
                width: `${viewportSize.width}px`,
                height: `${viewportSize.height}px`,
              }}
            >
              <img
                ref={imageRef}
                src={imageSrc}
                alt="To Crop"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                className="absolute origin-center select-none touch-none cursor-move max-w-none max-h-none"
                style={{
                  width: `${imageSize.width}px`,
                  height: `${imageSize.height}px`,
                  transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px) scale(${zoom})`,
                  left: '50%',
                  top: '50%',
                }}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center text-gray-400">
              <div className="w-8 h-8 border-2 border-[#D4AF37] border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-sm font-thai">กำลังโหลดรูปภาพ...</p>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="px-5 py-4 border-t border-white/5 space-y-4 bg-[#111115]">
          {/* Zoom Slider */}
          <div className="flex items-center gap-3">
            <ZoomOut className="w-4 h-4 text-gray-400" />
            <input
              type="range"
              min="1"
              max="3"
              step="0.01"
              value={zoom}
              onChange={(e) => handleZoomChange(parseFloat(e.target.value))}
              className="flex-1 accent-[#D4AF37] h-1 bg-white/10 rounded-lg appearance-none cursor-pointer"
            />
            <ZoomIn className="w-4 h-4 text-gray-400" />
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium border border-white/10 text-gray-300 hover:bg-white/5 hover:text-white transition-all font-thai"
            >
              ยกเลิก
            </button>
            <button
              onClick={handleCrop}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold bg-[#D4AF37] text-black hover:bg-[#c5a02e] transition-all flex items-center justify-center gap-1.5 font-thai shadow-lg"
            >
              <Crop className="w-4 h-4" />
              ครอปและใช้งาน
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
