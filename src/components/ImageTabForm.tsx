'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase-db';
import {
  Image as ImageIcon,
  Sparkles,
  Camera,
  RefreshCw,
  Trash2,
  Maximize2,
  Paintbrush,
  ZoomIn,
  Move,
  Loader2,
  CheckCircle,
  AlertCircle
} from 'lucide-react';

interface ImageTabFormProps {
  onImageGenerated?: (imageUrl: string) => void;
}

export default function ImageTabForm({ onImageGenerated }: ImageTabFormProps) {
  const { user, whitelistData } = useAuth();
  
  // Tab states
  const [imageMode, setImageMode] = useState<'text_to_image' | 'image_to_image' | 'inpainting' | 'outpainting'>('text_to_image');
  
  // Parameters states
  const [prompt, setPrompt] = useState('');
  const [modelType, setModelType] = useState('flux_dev'); // 'flux_dev' | 'flux_schnell'
  const [visualStyle, setVisualStyle] = useState('none');
  const [aspectRatio, setAspectRatio] = useState('1:1'); // '1:1' | '16:9' | '9:16'
  const [strength, setStrength] = useState(0.65);
  const [characterId, setCharacterId] = useState('');
  const [characters, setCharacters] = useState<any[]>([]);
  const [loadingCharacters, setLoadingCharacters] = useState(false);

  // File Upload states
  const [uploadedImage, setUploadedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>('');
  
  // Canvas drawing states (Inpainting)
  const [brushSize, setBrushSize] = useState(30);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  // Outpainting canvas positioning states
  const [scale, setScale] = useState(1.0);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const outpaintCanvasRef = useRef<HTMLCanvasElement>(null);

  // Camera Orbit states
  const [cameraAngle, setCameraAngle] = useState('default');
  const [cameraZoom, setCameraZoom] = useState('default');
  const joystickRef = useRef<HTMLDivElement>(null);
  const [joystickPos, setJoystickPos] = useState({ x: 0, y: 0 });
  const [isManipulatingJoystick, setIsManipulatingJoystick] = useState(false);

  // Generation flow states
  const [loading, setLoading] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [generatedImageUrl, setGeneratedImageUrl] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Styles presets
  const stylePresets = [
    { id: 'none', label: '🎨 ไม่มีฟิลเตอร์ (None)' },
    { id: 'cinematic', label: '🎬 ภาพยนตร์ (Cinematic)' },
    { id: 'studio', label: '📸 สตูดิโอพอร์ตเทรต (Studio Portrait)' },
    { id: 'pixar', label: '🧸 3D อนิเมชั่น (Pixar/3D)' },
    { id: 'retro', label: '🎞️ ฟิล์มเรโทร 90s (Retro Film)' },
    { id: 'anime', label: '🎌 อนิเมะญี่ปุ่น (Japanese Anime)' }
  ];

  useEffect(() => {
    if (user?.email) {
      loadCharacters();
    }
  }, [user]);

  const loadCharacters = async () => {
    setLoadingCharacters(true);
    try {
      // Fetch successful trained characters from database
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', user?.email)
        .single();
      
      if (profile) {
        const { data, error } = await supabase
          .from('characters')
          .select('*')
          .eq('user_id', profile.id)
          .eq('lora_status', 'succeeded')
          .order('created_at', { ascending: false });
        if (!error && data) {
          setCharacters(data);
        }
      }
    } catch (e) {
      console.warn('Failed to load characters:', e);
    } finally {
      setLoadingCharacters(false);
    }
  };

  // Reset states when switching mode
  const handleModeChange = (mode: typeof imageMode) => {
    setImageMode(mode);
    setUploadedImage(null);
    setImagePreview('');
    setOffsetX(0);
    setOffsetY(0);
    setScale(1.0);
    setErrorMsg('');
    setSuccessMsg('');
  };

  // Handle image upload
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadedImage(file);
      const url = URL.createObjectURL(file);
      setImagePreview(url);
      setOffsetX(0);
      setOffsetY(0);
      setScale(1.0);
      
      // Clear brush drawings
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    }
  };

  // --- HTML5 Drawing Canvas Logic (Inpainting) ---
  useEffect(() => {
    if (imageMode === 'inpainting' && imagePreview && canvasRef.current && imageRef.current) {
      const img = imageRef.current;
      const canvas = canvasRef.current;
      img.onload = () => {
        canvas.width = img.clientWidth;
        canvas.height = img.clientHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)'; // Translucent red brush
          ctx.lineWidth = brushSize;
        }
      };
      // Trigger load if image is already loaded
      if (img.complete) {
        canvas.width = img.clientWidth;
        canvas.height = img.clientHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
          ctx.lineWidth = brushSize;
        }
      }
    }
  }, [imageMode, imagePreview, brushSize]);

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setIsDrawing(true);
    ctx.lineWidth = brushSize;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';

    const rect = canvas.getBoundingClientRect();
    let clientX, clientY;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const x = clientX - rect.left;
    const y = clientY - rect.top;

    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const rect = canvas.getBoundingClientRect();
    let clientX, clientY;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const x = clientX - rect.left;
    const y = clientY - rect.top;

    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    setIsDrawing(false);
  };

  const clearMask = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  // --- Outpainting Frame Canvas Rendering & Logic ---
  useEffect(() => {
    if (imageMode === 'outpainting' && imagePreview && outpaintCanvasRef.current) {
      const canvas = outpaintCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Set aspect ratio size (Target size: 16:9 -> 640x360, 9:16 -> 360x640, 1:1 -> 500x500)
      let targetW = 500;
      let targetH = 500;
      if (aspectRatio === '16:9') {
        targetW = 640;
        targetH = 360;
      } else if (aspectRatio === '9:16') {
        targetW = 360;
        targetH = 640;
      }

      canvas.width = targetW;
      canvas.height = targetH;

      const img = new Image();
      img.src = imagePreview;
      img.onload = () => {
        // Clear canvas
        ctx.fillStyle = '#0F0F11';
        ctx.fillRect(0, 0, targetW, targetH);

        // Draw helper boundaries
        ctx.strokeStyle = 'rgba(212, 175, 55, 0.4)';
        ctx.lineWidth = 2;
        ctx.strokeRect(0, 0, targetW, targetH);

        // Calculate size to preserve aspect ratio on draw
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        
        // Center image + offsets
        const startX = (targetW - drawW) / 2 + offsetX;
        const startY = (targetH - drawH) / 2 + offsetY;

        ctx.drawImage(img, startX, startY, drawW, drawH);
      };
    }
  }, [imageMode, imagePreview, scale, offsetX, offsetY, aspectRatio]);

  const handleOutpaintDragStart = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
  };

  const handleOutpaintDrag = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setOffsetX((prev) => prev + dx);
    setOffsetY((prev) => prev + dy);
    dragStart.current = { x: e.clientX, y: e.clientY };
  };

  const handleOutpaintDragEnd = () => {
    setIsDragging(false);
  };

  // --- Orbit Camera Circular Control logic ---
  const handleJoystickStart = () => {
    setIsManipulatingJoystick(true);
  };

  const handleJoystickMove = (e: any) => {
    if (!isManipulatingJoystick || !joystickRef.current) return;
    const rect = joystickRef.current.getBoundingClientRect();
    const radius = rect.width / 2;
    const centerX = rect.left + radius;
    const centerY = rect.top + radius;

    let clientX, clientY;
    if ('touches' in e || (e.touches && e.touches.length > 0)) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Limit handle movement to the circle boundary
    const limit = radius - 15;
    let newX = dx;
    let newY = dy;
    if (distance > limit) {
      newX = (dx / distance) * limit;
      newY = (dy / distance) * limit;
    }

    setJoystickPos({ x: newX, y: newY });

    // Map coordinates to camera angles
    const angleX = newX / limit; // -1 to 1 (left to right)
    const angleY = newY / limit; // -1 to 1 (up to down)

    // Elevation & Azimuth Mapping
    let angleLabel = 'default';
    if (Math.abs(angleX) > 0.4 || Math.abs(angleY) > 0.4) {
      if (Math.abs(angleX) > Math.abs(angleY)) {
        angleLabel = angleX < 0 ? 'side profile view shot from the left side' : 'side profile view shot from the right side';
      } else {
        angleLabel = angleY < 0 ? 'high angle shot, looking down at the subject' : 'low angle shot, dramatic camera tilt looking up';
      }
    }
    setCameraAngle(angleLabel);
  };

  const handleJoystickEnd = () => {
    setIsManipulatingJoystick(false);
  };

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isManipulatingJoystick) handleJoystickEnd();
    };
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isManipulatingJoystick) handleJoystickMove(e);
    };
    const handleGlobalTouchEnd = () => {
      if (isManipulatingJoystick) handleJoystickEnd();
    };
    const handleGlobalTouchMove = (e: TouchEvent) => {
      if (isManipulatingJoystick) handleJoystickMove(e);
    };

    window.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('touchend', handleGlobalTouchEnd);
    window.addEventListener('touchmove', handleGlobalTouchMove, { passive: false });
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('touchend', handleGlobalTouchEnd);
      window.removeEventListener('touchmove', handleGlobalTouchMove);
    };
  }, [isManipulatingJoystick]);

  const resetJoystick = () => {
    setJoystickPos({ x: 0, y: 0 });
    setCameraAngle('default');
  };

  // --- Submit & API Generation logic ---
  const generateImage = async () => {
    setErrorMsg('');
    setSuccessMsg('');
    
    if (imageMode !== 'text_to_image' && !uploadedImage) {
      setErrorMsg('กรุณาอัปโหลดรูปภาพอ้างอิงสำหรับโหมดนี้');
      return;
    }

    setLoading(true);
    setProgressPercent(10);
    setProgressMessage('กำลังเตรียมชุดรูปภาพและข้อมูล...');

    try {
      const formData = new FormData();
      formData.set('prompt', prompt);
      formData.set('image_mode', imageMode);
      formData.set('model_type', modelType);
      formData.set('visual_style', visualStyle);
      formData.set('camera_angle', cameraAngle);
      formData.set('camera_zoom', cameraZoom);
      formData.set('character_id', characterId);
      formData.set('user_email', user?.email || '');
      formData.set('user_id', user?.id || '');
      formData.set('aspect_ratio', aspectRatio);
      formData.set('strength', strength.toString());

      // Prepare Inpainting Blobs
      if (imageMode === 'inpainting') {
        formData.set('image', uploadedImage!);

        // Generate mask image blob from brush canvas
        const maskCanvas = document.createElement('鏡'); // offscreen canvas
        const maskCanvasElement = document.createElement('canvas');
        maskCanvasElement.width = canvasRef.current!.width;
        maskCanvasElement.height = canvasRef.current!.height;
        const mCtx = maskCanvasElement.getContext('2d');
        if (mCtx) {
          mCtx.fillStyle = 'black';
          mCtx.fillRect(0, 0, maskCanvasElement.width, maskCanvasElement.height);

          // Draw the brush strokes as white mask
          const drawCanvas = canvasRef.current!;
          mCtx.globalCompositeOperation = 'source-over';
          
          // Re-draw the brush strokes from canvas using white color
          mCtx.drawImage(drawCanvas, 0, 0);
          
          // Convert drawn canvas pixels: if red brush translucent pixel, make it pure white
          const imgData = mCtx.getImageData(0, 0, maskCanvasElement.width, maskCanvasElement.height);
          for (let i = 0; i < imgData.data.length; i += 4) {
            // Check if there is red brush pixel drawn (alpha > 0)
            if (imgData.data[i + 3] > 0) {
              imgData.data[i] = 255;   // R
              imgData.data[i + 1] = 255; // G
              imgData.data[i + 2] = 255; // B
              imgData.data[i + 3] = 255; // A (opaque white)
            }
          }
          mCtx.putImageData(imgData, 0, 0);

          const maskBlob = await new Promise<Blob | null>((res) => maskCanvasElement.toBlob(res, 'image/png'));
          if (maskBlob) {
            formData.set('mask', new File([maskBlob], 'mask.png', { type: 'image/png' }));
          }
        }
      }

      // Prepare Outpainting Blobs
      if (imageMode === 'outpainting') {
        const outCanvas = outpaintCanvasRef.current!;
        const compositeBlob = await new Promise<Blob | null>((res) => outCanvas.toBlob(res, 'image/png'));
        if (compositeBlob) {
          formData.set('image', new File([compositeBlob], 'composite.png', { type: 'image/png' }));
        }

        // Generate mask image: original image shape is black, margins are white
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = outCanvas.width;
        maskCanvas.height = outCanvas.height;
        const mCtx = maskCanvas.getContext('2d');
        if (mCtx) {
          // Fill whole frame with white
          mCtx.fillStyle = 'white';
          mCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);

          // Find coordinates of original image and paint that box black
          const img = new Image();
          img.src = imagePreview;
          await new Promise((res) => { img.onload = res; });
          const drawW = img.width * scale;
          const drawH = img.height * scale;
          const startX = (maskCanvas.width - drawW) / 2 + offsetX;
          const startY = (maskCanvas.height - drawH) / 2 + offsetY;

          mCtx.fillStyle = 'black';
          mCtx.fillRect(startX, startY, drawW, drawH);

          const maskBlob = await new Promise<Blob | null>((res) => maskCanvas.toBlob(res, 'image/png'));
          if (maskBlob) {
            formData.set('mask', new File([maskBlob], 'mask.png', { type: 'image/png' }));
          }
        }
      }

      setProgressMessage('กำลังขยายและปรับแต่ง Prompt...');
      setProgressPercent(20);

      // Submit generation call to backend API
      const response = await fetch('/api/generate-image', {
        method: 'POST',
        body: formData
      });

      const resJson = await response.json();
      if (!response.ok || !resJson.success) {
        throw new Error(resJson.error || 'เกิดข้อผิดพลาดในการสั่งงานไปยังระบบคลาวด์');
      }

      const { requestId, videoPath } = resJson;
      setProgressMessage('กำลังต่อคิวรันภาพบนเซิร์ฟเวอร์ AI...');
      setProgressPercent(40);

      // Start Polling loop using video-status (since it's now updated to support images)
      let checkCount = 0;
      const intervalId = setInterval(async () => {
        checkCount++;
        try {
          const statusRes = await fetch('/api/video-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requestId,
              videoPath,
              modelType: modelType.includes('flux') ? modelType : 'flux_dev',
              storageProvider: 'supabase'
            })
          });

          if (!statusRes.ok) {
            console.warn('Status check failed');
            return;
          }

          const statusData = await statusRes.json();
          const { status, progressMessage: msg, progressPercent: pct, videoUrl } = statusData;

          if (status === 'COMPLETED' && videoUrl) {
            clearInterval(intervalId);
            setGeneratedImageUrl(videoUrl);
            setSuccessMsg('🎉 สร้างรูปภาพของคุณสำเร็จเรียบร้อยแล้ว!');
            setLoading(false);
            if (onImageGenerated) onImageGenerated(videoUrl);
          } else if (status === 'FAILED') {
            clearInterval(intervalId);
            throw new Error(statusData.error || 'การประมวลผลโมเดลล้มเหลว');
          } else {
            setProgressMessage(msg || 'กำลังเจนภาพ...');
            setProgressPercent(pct || Math.min(85, 40 + checkCount * 2));
          }
        } catch (pollErr: any) {
          clearInterval(intervalId);
          setErrorMsg(pollErr.message || 'เกิดข้อผิดพลาดระหว่างรอผลลัพธ์ภาพ');
          setLoading(false);
        }
      }, 3000);

    } catch (err: any) {
      setErrorMsg(err.message || 'เกิดข้อผิดพลาดในการประมวลผล');
      setLoading(false);
    }
  };

  return (
    <div className="glow-card p-6 mb-8 font-thai">
      <h2 className="text-xl font-display font-semibold text-text-primary mb-4 flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-[#D4AF37]" />
        ระบบสร้างรูปภาพอัจฉริยะ (Image Generator)
      </h2>

      {/* Mode Sub-Tabs */}
      <div className="grid grid-cols-4 gap-1.5 p-1 bg-[#1A1A1D] rounded-xl border border-white/5 mb-6">
        {(['text_to_image', 'image_to_image', 'inpainting', 'outpainting'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => handleModeChange(mode)}
            className={`py-2 rounded-lg text-[10px] sm:text-xs font-bold transition-all ${
              imageMode === mode
                ? 'bg-[#D4AF37] text-black shadow-md'
                : 'text-text-muted hover:text-white'
            }`}
          >
            {mode === 'text_to_image' && '📝 วาดจากข้อความ'}
            {mode === 'image_to_image' && '🖼️ แปลงจากรูปภาพ'}
            {mode === 'inpainting' && '🖌️ แก้เฉพาะจุด'}
            {mode === 'outpainting' && '📐 เติมขยายเฟรม'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left column: Controls */}
        <div className="lg:col-span-7 space-y-5">
          {/* Prompt */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-text-secondary uppercase">
              ✍️ คำอธิบายรายละเอียดภาพ (Prompt) *
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                imageMode === 'inpainting'
                  ? 'เขียนบอก AI ว่าอยากให้วาดอะไรลงไปในจุดที่ระบายพู่กัน เช่น "ใส่แว่นตากันแดดทรงสปอร์ตสีดำ, realistic"'
                  : imageMode === 'outpainting'
                    ? 'บรรยายฉากข้างเคียงเพื่อช่วย AI ขยายฉากให้กลมกลืน เช่น "ฉากห้องเรียนคณิตศาสตร์ขนาดใหญ่เบลอหลัง"'
                    : 'ป้อนรายละเอียดภาพที่ต้องการสร้าง เช่น "ครูผู้หญิงไทยสอนคณิตศาสตร์ สวมสูทสีน้ำเงิน หน้าตายิ้มแย้ม สไตล์พิกซาร์"'
              }
              rows={3}
              className="w-full bg-[#1C1C1E] border border-white/10 p-3 rounded-xl text-sm text-white placeholder-gray-500 outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] transition-all"
            />
          </div>

          {/* Model & Ratio Parameters (Hidden for Paint/Uncrop) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-text-secondary uppercase">
                ⚙️ ความเร็วประมวลผล (Model Speed)
              </label>
              <div className="flex gap-2 bg-[#1C1C1E] p-1.5 rounded-xl border border-white/10">
                <button
                  type="button"
                  onClick={() => setModelType('flux_schnell')}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${
                    modelType === 'flux_schnell' ? 'bg-white text-black shadow-md' : 'text-text-muted hover:text-white'
                  }`}
                >
                  ⚡ Schnell (ไว/ราคาประหยัด)
                </button>
                <button
                  type="button"
                  onClick={() => setModelType('flux_dev')}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${
                    modelType === 'flux_dev' ? 'bg-white text-black shadow-md' : 'text-text-muted hover:text-white'
                  }`}
                >
                  👑 Dev (สมจริงระดับโปร)
                </button>
              </div>
            </div>

            {imageMode !== 'inpainting' && imageMode !== 'outpainting' && imageMode !== 'image_to_image' && (
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-text-secondary uppercase">
                  📐 สัดส่วนรูปภาพ (Aspect Ratio)
                </label>
                <div className="flex gap-2 bg-[#1C1C1E] p-1.5 rounded-xl border border-white/10">
                  {['1:1', '16:9', '9:16'].map((ratio) => (
                    <button
                      key={ratio}
                      type="button"
                      onClick={() => setAspectRatio(ratio)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${
                        aspectRatio === ratio ? 'bg-white text-black shadow-md' : 'text-text-muted hover:text-white'
                      }`}
                    >
                      {ratio}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {imageMode === 'outpainting' && (
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-text-secondary uppercase">
                  📐 เปลี่ยนสัดส่วนเฟรมปลายทาง (Target Frame)
                </label>
                <div className="flex gap-2 bg-[#1C1C1E] p-1.5 rounded-xl border border-white/10">
                  {['1:1', '16:9', '9:16'].map((ratio) => (
                    <button
                      key={ratio}
                      type="button"
                      onClick={() => setAspectRatio(ratio)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${
                        aspectRatio === ratio ? 'bg-white text-black shadow-md' : 'text-text-muted hover:text-white'
                      }`}
                    >
                      {ratio}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Character Library integration */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-text-secondary uppercase">
                👤 สวมใบหน้าจากคลังตัวละคร (Character LoRA)
              </label>
              {loadingCharacters ? (
                <div className="py-2.5 px-3 bg-[#1C1C1E] border border-white/10 rounded-xl flex items-center justify-center">
                  <Loader2 className="w-4 h-4 animate-spin text-text-muted" />
                </div>
              ) : (
                <select
                  value={characterId}
                  onChange={(e) => setCharacterId(e.target.value)}
                  className="w-full bg-[#1C1C1E] border border-white/10 p-3 rounded-xl text-xs sm:text-sm text-white outline-none cursor-pointer"
                >
                  <option value="">👤 เจนใบหน้าตัวละครใหม่ทั่วไป (None)</option>
                  {characters.map((char) => (
                    <option key={char.id} value={char.id}>
                      👤 {char.name} ({char.lora_trigger_word})
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Visual Styles */}
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-text-secondary uppercase">
                🎨 สไตล์ศิลปะ (Visual Style Presets)
              </label>
              <select
                value={visualStyle}
                onChange={(e) => setVisualStyle(e.target.value)}
                className="w-full bg-[#1C1C1E] border border-white/10 p-3 rounded-xl text-xs sm:text-sm text-white outline-none cursor-pointer"
              >
                {stylePresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Strength Slider for Image to Image */}
          {imageMode === 'image_to_image' && (
            <div className="space-y-1.5 p-4 rounded-xl bg-[#1C1C1E] border border-white/10">
              <div className="flex justify-between text-xs font-semibold">
                <span className="text-text-secondary uppercase">🎚️ ระดับความแรงในการเปลี่ยนรูป (Denoising Strength)</span>
                <span className="text-[#D4AF37] font-mono">{strength.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0.10"
                max="0.95"
                step="0.05"
                value={strength}
                onChange={(e) => setStrength(parseFloat(e.target.value))}
                className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
              />
              <div className="flex justify-between text-[10px] text-text-muted">
                <span>แก้ไขน้อย (คล้ายต้นแบบมาก)</span>
                <span>แก้ไขมาก (วาดใหม่เยอะ)</span>
              </div>
            </div>
          )}

          {/* Orbit Camera Joypad & Zoom sliders */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-xl bg-[#1C1C1E] border border-white/10">
            <div className="flex flex-col items-center justify-center space-y-3">
              <label className="text-xs font-semibold text-text-secondary uppercase text-center w-full">
                🔄 หมุนคันโยกปรับทิศทางมุมกล้อง (Camera Orbit)
              </label>
              <div 
                ref={joystickRef}
                onMouseDown={handleJoystickStart}
                onTouchStart={handleJoystickStart}
                className="relative w-36 h-36 rounded-full bg-black border-2 border-white/10 flex items-center justify-center cursor-grab active:cursor-grabbing"
              >
                {/* Visual grid lines */}
                <div className="absolute inset-0 border-t border-white/5 top-1/2"></div>
                <div className="absolute inset-0 border-l border-white/5 left-1/2"></div>
                
                {/* Drag handle */}
                <div
                  style={{
                    transform: `translate(${joystickPos.x}px, ${joystickPos.y}px)`,
                    transition: isManipulatingJoystick ? 'none' : 'transform 0.2s ease-out'
                  }}
                  className="w-8 h-8 rounded-full bg-[#D4AF37] shadow-lg flex items-center justify-center text-black font-bold text-xs"
                >
                  <Camera className="w-4 h-4 text-black" />
                </div>
              </div>
              <button
                type="button"
                onClick={resetJoystick}
                className="text-[10px] text-text-muted hover:text-white transition-colors"
              >
                🔄 รีเซ็ตมุมกล้องปกติ
              </button>
            </div>

            <div className="space-y-4 flex flex-col justify-center">
              <div>
                <span className="text-[10px] text-text-muted font-bold block mb-1">สถานะทิศทางมุมกล้องที่ตรวจจับได้:</span>
                <span className="text-xs text-[#D4AF37] font-semibold block bg-black/40 p-2 rounded-lg border border-white/5">
                  {cameraAngle === 'default' ? '📸 หน้าตรงปกติ (Default)' : `📸 ${cameraAngle}`}
                </span>
              </div>

              <div className="space-y-1.5">
                <label className="block text-[10px] font-bold text-text-secondary uppercase">
                  🔍 ระยะซูมและจัดเฟรม subject (Camera Zoom)
                </label>
                <select
                  value={cameraZoom}
                  onChange={(e) => setCameraZoom(e.target.value)}
                  className="w-full bg-black border border-white/10 p-2 rounded-lg text-xs text-white outline-none cursor-pointer"
                >
                  <option value="default">📸 ระยะกล้องมาตรฐาน (Default)</option>
                  <option value="close-up">🔍 โคลสอัพครึ่งตัว (Close-Up Portrait)</option>
                  <option value="extreme-close-up">🔎 โคลสอัพเจาะเฉพาะใบหน้า (Extreme Close-Up)</option>
                  <option value="wide-shot">🗺️ ระยะกว้างเต็มตัว (Medium Full Shot)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Errors and Progress */}
          {errorMsg && (
            <div className="p-3.5 rounded-xl bg-accent-danger/10 border border-accent-danger/25 text-xs text-accent-danger flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-3.5 rounded-xl bg-accent-success/10 border border-accent-success/25 text-xs text-accent-success flex items-center gap-2 animate-fade-in">
              <CheckCircle className="w-4 h-4 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {loading && (
            <div className="p-4 rounded-xl bg-surface-2 border border-white/5 space-y-3">
              <div className="flex justify-between items-center text-xs">
                <span className="text-text-secondary font-medium">{progressMessage}</span>
                <span className="text-[#D4AF37] font-bold font-mono">{progressPercent}%</span>
              </div>
              <div className="w-full h-1.5 bg-black/50 rounded-full overflow-hidden">
                <div 
                  style={{ width: `${progressPercent}%` }}
                  className="h-full bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB] rounded-full transition-all duration-300"
                ></div>
              </div>
            </div>
          )}

          {/* Action button */}
          <button
            type="button"
            disabled={loading}
            onClick={generateImage}
            className="w-full py-4 rounded-xl bg-[#D4AF37] hover:bg-[#D4AF37]/90 disabled:opacity-50 text-black font-bold shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 text-sm sm:text-base cursor-pointer"
          >
            {loading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>กำลังประมวลผลรูปภาพ...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                <span>สร้างรูปภาพผลลัพธ์ (หัก 15 เครดิต)</span>
              </>
            )}
          </button>
        </div>

        {/* Right column: Previews / Interactive canvases */}
        <div className="lg:col-span-5 flex flex-col justify-start">
          {imageMode === 'text_to_image' ? (
            <div className="border border-white/10 rounded-2xl bg-black/30 overflow-hidden flex flex-col justify-center items-center p-6 h-[400px] border-dashed">
              {generatedImageUrl ? (
                <div className="relative w-full h-full flex items-center justify-center bg-black">
                  <img 
                    src={generatedImageUrl} 
                    alt="Generated output" 
                    className="max-w-full max-h-full object-contain rounded-xl"
                  />
                  <a
                    href={generatedImageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="absolute bottom-3 right-3 px-3 py-1.5 rounded-lg bg-black/60 text-white text-xs border border-white/10 backdrop-blur-md hover:bg-black transition-colors"
                  >
                    💾 ดาวน์โหลดรูปภาพ
                  </a>
                </div>
              ) : (
                <>
                  <ImageIcon className="w-12 h-12 text-white/20 mb-3" />
                  <p className="text-sm font-medium text-text-muted text-center">
                    ป้อนข้อความ Prompt แล้วกดปุ่มสร้างรูปภาพด้านซ้าย
                    <br />
                    รูปภาพผลลัพธ์จะปรากฏที่นี่
                  </p>
                </>
              )}
            </div>
          ) : (
            /* Image-based modes */
            <div className="space-y-4">
              <label className="block text-xs font-semibold text-text-secondary uppercase">
                📁 รูปภาพอ้างอิงและพื้นที่ประมวลผล (Workspace Preview)
              </label>

              {/* Uploader */}
              {!imagePreview ? (
                <div className="border border-white/10 rounded-2xl bg-black/30 overflow-hidden flex flex-col justify-center items-center p-8 h-[320px] border-dashed hover:border-white/20 transition-all cursor-pointer relative">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                  <ImageIcon className="w-10 h-10 text-white/20 mb-3" />
                  <p className="text-xs sm:text-sm font-medium text-text-muted text-center">
                    คลิกเพื่อเลือกไฟล์ หรือลากรูปภาพมาวางที่นี่
                  </p>
                  <span className="text-[10px] text-text-muted mt-1">(รองรับ .png, .jpg, .jpeg)</span>
                </div>
              ) : (
                /* Interactive Canvas containers */
                <div className="space-y-3">
                  <div className="relative border border-white/10 rounded-2xl bg-[#0F0F11] overflow-hidden flex items-center justify-center p-4">
                    {/* Mode: Standard Image to Image */}
                    {imageMode === 'image_to_image' && (
                      <img 
                        src={imagePreview} 
                        alt="Preview" 
                        className="max-h-[350px] w-auto object-contain rounded-xl"
                      />
                    )}

                    {/* Mode: Inpainting (Drawing Brush Mask) */}
                    {imageMode === 'inpainting' && (
                      <div className="relative inline-block overflow-hidden max-h-[350px]">
                        <img
                          ref={imageRef}
                          src={imagePreview}
                          alt="Drawing preview"
                          className="max-h-[350px] w-auto object-contain rounded-xl select-none"
                        />
                        <canvas
                          ref={canvasRef}
                          onMouseDown={startDrawing}
                          onMouseMove={draw}
                          onMouseUp={stopDrawing}
                          onMouseLeave={stopDrawing}
                          onTouchStart={startDrawing}
                          onTouchMove={draw}
                          onTouchEnd={stopDrawing}
                          className="absolute inset-0 cursor-crosshair rounded-xl touch-none"
                        />
                      </div>
                    )}

                    {/* Mode: Outpainting (Drag & Scale Uncrop Frame) */}
                    {imageMode === 'outpainting' && (
                      <div className="relative w-full flex flex-col items-center justify-center p-4">
                        <canvas
                          ref={outpaintCanvasRef}
                          onMouseDown={handleOutpaintDragStart}
                          onMouseMove={handleOutpaintDrag}
                          onMouseUp={handleOutpaintDragEnd}
                          onMouseLeave={handleOutpaintDragEnd}
                          className="cursor-move border border-[#D4AF37]/30 rounded-xl shadow-lg"
                        />
                        <span className="text-[10px] text-text-muted mt-2 block flex items-center gap-1">
                          <Move className="w-3 h-3" /> ลากเมาส์ขยับตำแหน่งรูปในเฟรมด้านบน
                        </span>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => handleModeChange(imageMode)}
                      className="absolute top-3 right-3 p-2 rounded-lg bg-black/60 hover:bg-black text-text-muted hover:text-white border border-white/10 transition-colors"
                      title="ลบรูปภาพ"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Canvas controls for Inpainting */}
                  {imageMode === 'inpainting' && (
                    <div className="p-3 bg-[#1C1C1E] rounded-xl border border-white/10 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={clearMask}
                          className="text-xs bg-black/50 border border-white/10 hover:bg-black text-text-muted hover:text-white px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors font-bold"
                        >
                          <RefreshCw className="w-3 h-3" /> ล้างหน้ากากพู่กัน
                        </button>
                      </div>

                      {/* Brush size slider */}
                      <div className="flex items-center gap-2">
                        <Paintbrush className="w-3.5 h-3.5 text-text-secondary" />
                        <span className="text-[10px] text-text-muted font-bold font-mono w-6">{brushSize}px</span>
                        <input
                          type="range"
                          min="10"
                          max="80"
                          step="5"
                          value={brushSize}
                          onChange={(e) => setBrushSize(parseInt(e.target.value, 10))}
                          className="w-24 h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
                        />
                      </div>
                    </div>
                  )}

                  {/* Scale zoom controls for Outpainting */}
                  {imageMode === 'outpainting' && (
                    <div className="p-3 bg-[#1C1C1E] rounded-xl border border-white/10 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 w-full">
                        <ZoomIn className="w-4 h-4 text-text-secondary" />
                        <span className="text-[10px] text-text-muted font-bold font-mono w-12">ซูม: {Math.round(scale * 100)}%</span>
                        <input
                          type="range"
                          min="0.2"
                          max="2.5"
                          step="0.05"
                          value={scale}
                          onChange={(e) => setScale(parseFloat(e.target.value))}
                          className="flex-1 h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Generated Image output for image modes */}
              {generatedImageUrl && (
                <div className="relative border border-white/10 rounded-2xl bg-black overflow-hidden flex items-center justify-center p-4 h-[280px]">
                  <img 
                    src={generatedImageUrl} 
                    alt="Generated output" 
                    className="max-w-full max-h-full object-contain rounded-xl"
                  />
                  <a
                    href={generatedImageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="absolute bottom-3 right-3 px-3 py-1.5 rounded-lg bg-black/60 text-white text-xs border border-white/10 backdrop-blur-md hover:bg-black transition-colors"
                  >
                    💾 ดาวน์โหลดรูปภาพ
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
