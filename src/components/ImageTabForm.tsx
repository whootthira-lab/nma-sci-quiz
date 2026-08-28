'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth-context';
import { downscaleImage, readJsonOrExplain } from '@/lib/image-utils';
import { supabase } from '@/lib/supabase-db';
import { takeRegen, storageUrl, urlToFile } from '@/lib/regen';
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
  AlertCircle,
  Wand2
} from 'lucide-react';

interface ImageTabFormProps {
  onImageGenerated?: (imageUrl: string) => void;
}

export default function ImageTabForm({ onImageGenerated }: ImageTabFormProps) {
  const { user, whitelistData } = useAuth();
  
  // Tab states
  const [imageMode, setImageMode] = useState<'text_to_image' | 'image_to_image' | 'kontext' | 'camera' | 'relight' | 'colorgrade' | 'bgreplace' | 'upscale' | 'inpainting' | 'outpainting'>('text_to_image');
  
  // Parameters states
  const [prompt, setPrompt] = useState('');
  const [enhancing, setEnhancing] = useState(false);
  const [modelType, setModelType] = useState('flux_dev'); // 'flux_dev' | 'flux_schnell'
  const [visualStyle, setVisualStyle] = useState('none');
  const [skipEnhance, setSkipEnhance] = useState(false); // skip the LLM prompt enhancer to save tokens
  const [aspectRatio, setAspectRatio] = useState('1:1'); // '1:1' | '16:9' | '9:16'
  const [strength, setStrength] = useState(0.65);
  const [characterId, setCharacterId] = useState('');
  const [characters, setCharacters] = useState<any[]>([]);
  const [loadingCharacters, setLoadingCharacters] = useState(false);

  // File Upload states
  const [uploadedImage, setUploadedImage] = useState<File | null>(null);
  // After turning a viewpoint, paste the original face back over the result
  const [restoreFace, setRestoreFace] = useState(false);
  // Which editor performs the rotation. Compared on one portrait: the pricier models are
  // sharper but drift the face, so the cheapest capable one leads.
  const [editModel, setEditModel] = useState<'auto' | 'flux2' | 'nano' | 'nanopro' | 'gptimage' | 'grok' | 'grokq'>('auto');
  // Modes that work by handing a model an image and an instruction, so any of the editors
  // below can serve them. Masked fills and the upscaler need a specific model and are out.
  const EDIT_CAPABLE_MODES = ['camera', 'kontext', 'image_to_image', 'relight', 'colorgrade', 'bgreplace'];
  const EDIT_MODEL_OPTIONS = [
    { id: 'flux2',    label: '⚡ Flux 2 Pro — คมชัด คุ้มที่สุด', credits: 3 },
    { id: 'nano',     label: '🍌 Nano Banana — เหมือนต้นฉบับที่สุด', credits: 4 },
    { id: 'nanopro',  label: '🍌 Nano Banana Pro — ละเอียดสูง', credits: 15 },
    { id: 'gptimage', label: '🧠 GPT Image — เก่งคำสั่งซับซ้อน/ตัวหนังสือ', credits: 14 },
    { id: 'grok',     label: '🤖 Grok Imagine — ราคาเท่า Flux 2', credits: 3 },
    { id: 'grokq',    label: '🤖 Grok Imagine Quality — คมกว่า', credits: 7 },
  ] as const;
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

  // Secondary Overlay Image states (Inpainting object insertion)
  const [overlayFile, setOverlayFile] = useState<File | null>(null);
  const [overlayImagePreview, setOverlayImagePreview] = useState<string>('');
  const [isRemovingBg, setIsRemovingBg] = useState(false);
  const [overlayScale, setOverlayScale] = useState(1.0);
  const [overlayRotate, setOverlayRotate] = useState(0);
  const [overlayX, setOverlayX] = useState(0);
  const [overlayY, setOverlayY] = useState(0);
  const [isDraggingOverlay, setIsDraggingOverlay] = useState(false);
  const overlayDragStart = useRef({ x: 0, y: 0, overlayX: 0, overlayY: 0 });

  // Camera Orbit states
  const [cameraAngle, setCameraAngle] = useState('default');
  const [cameraZoom, setCameraZoom] = useState('default');
  const joystickCanvasRef = useRef<HTMLCanvasElement>(null);
  const [yaw, setYaw] = useState(0); // -180 to 180 degrees
  const [pitch, setPitch] = useState(0); // -80 to 80 degrees
  const [isDraggingSphere, setIsDraggingSphere] = useState(false);
  const sphereDragStart = useRef({ x: 0, y: 0, yaw: 0, pitch: 0 });

  // Generation flow states
  const [loading, setLoading] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [generatedImageUrl, setGeneratedImageUrl] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const getContainerAspectClass = () => {
    if (aspectRatio === '16:9') return 'aspect-[16/9] w-full max-h-[350px]';
    if (aspectRatio === '9:16') return 'aspect-[9/16] h-[350px]';
    return 'aspect-square h-[350px]'; // 1:1
  };

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

  // "สร้างอีกครั้ง" from the gallery: refill the form the way it was submitted. Everything
  // is best-effort — whatever an older record never stored simply keeps its default.
  useEffect(() => {
    const regen = takeRegen('image');
    if (!regen) return;
    const md = regen.metadata || {};

    const mode = (regen.mode || '').replace(/^image-/, '');
    const KNOWN_MODES = ['text_to_image', 'image_to_image', 'kontext', 'camera', 'relight', 'colorgrade', 'bgreplace', 'upscale', 'inpainting', 'outpainting'];
    if (KNOWN_MODES.includes(mode)) setImageMode(mode as typeof imageMode);

    if (regen.prompt) setPrompt(regen.prompt);
    if (['flux_dev', 'flux_schnell', 'grok', 'flux2pro'].includes(regen.model_name)) setModelType(regen.model_name);
    if (['1:1', '16:9', '9:16'].includes(regen.aspect_ratio)) setAspectRatio(regen.aspect_ratio);
    if (md.visual_style) setVisualStyle(md.visual_style);
    if (md.camera_zoom) setCameraZoom(md.camera_zoom);
    if (md.edit_model && md.edit_model !== 'auto') setEditModel(md.edit_model);
    if (typeof md.strength === 'number') setStrength(md.strength);
    if (typeof md.camera_yaw === 'number') setYaw(md.camera_yaw);
    if (typeof md.camera_pitch === 'number') setPitch(md.camera_pitch);
    if (md.character_id) setCharacterId(md.character_id);

    // Re-attach the source photo as if just picked; the stored input beats the output URL
    const src = md.image_path ? storageUrl(md.image_path) : (md.face_restore_source || regen.source_image_url);
    if (src && mode !== 'text_to_image') {
      urlToFile(src, 'source.png').then((file) => {
        if (file) {
          setUploadedImage(file);
          setImagePreview(URL.createObjectURL(file));
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadCharacters = async () => {
    setLoadingCharacters(true);
    try {
      const res = await fetch(`/api/characters/access?email=${encodeURIComponent(user?.email || '')}&trained_only=true`);
      const json = await res.json();
      if (json.success) setCharacters(json.characters || []);
    } catch (e) {
      console.warn('Failed to load characters:', e);
    } finally {
      setLoadingCharacters(false);
    }
  };

  // Reset states when switching mode
  const handleModeChange = (mode: typeof imageMode) => {
    // Switching between modes that all edit the same uploaded picture should keep it —
    // discarding it made the preview go blank when moving to another editing mode.
    const editsAnImage = (m: typeof imageMode) => m !== 'text_to_image';
    const keepSource = editsAnImage(imageMode) && editsAnImage(mode);

    setImageMode(mode);
    if (!keepSource) {
      setUploadedImage(null);
      setImagePreview('');
    }
    setOffsetX(0);
    setOffsetY(0);
    setScale(1.0);
    setOverlayFile(null);
    setOverlayImagePreview('');
    setOverlayScale(1.0);
    setOverlayRotate(0);
    setOverlayX(0);
    setOverlayY(0);
    setErrorMsg('');
    setSuccessMsg('');
  };

  /** Clear the attached picture so another can be chosen. The bin used to call
   *  handleModeChange, which now deliberately keeps the source when the mode still
   *  edits an image — so the button had stopped removing anything. */
  const clearUploadedImage = () => {
    if (imagePreview?.startsWith('blob:')) URL.revokeObjectURL(imagePreview);
    setUploadedImage(null);
    setImagePreview('');
    setOverlayFile(null);
    setOverlayImagePreview('');
    setOffsetX(0);
    setOffsetY(0);
    setScale(1.0);
    setErrorMsg('');
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
  };

  // Handle image upload
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (picked) {
      // Shrink before anything else so the preview, the canvases and the upload
      // all work from a size the server will accept
      const file = await downscaleImage(picked);
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

  // Handle secondary overlay image upload and background removal
  const handleOverlayUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setOverlayFile(file);
    setIsRemovingBg(true);
    setErrorMsg('');

    try {
      const formData = new FormData();
      formData.append('image', file);
      formData.append('user_email', user?.email || '');

      const response = await fetch('/api/remove-bg', {
        method: 'POST',
        body: formData
      });

      const resJson = await readJsonOrExplain(response);
      if (!response.ok || !resJson.success) {
        throw new Error(resJson.error || 'ลบพื้นหลังล้มเหลว');
      }

      setOverlayImagePreview(resJson.transparentImageUrl);
      setOverlayScale(1.0);
      setOverlayRotate(0);
      setOverlayX(0);
      setOverlayY(0);
    } catch (err: any) {
      setErrorMsg(err.message || 'เกิดข้อผิดพลาดในการลบพื้นหลัง');
      setOverlayFile(null);
    } finally {
      setIsRemovingBg(false);
    }
  };

  const handleOverlayDragStart = (e: React.MouseEvent) => {
    setIsDraggingOverlay(true);
    overlayDragStart.current = { x: e.clientX, y: e.clientY, overlayX, overlayY };
    e.stopPropagation();
  };

  const handleOverlayTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length > 0) {
      setIsDraggingOverlay(true);
      overlayDragStart.current = { 
        x: e.touches[0].clientX, 
        y: e.touches[0].clientY, 
        overlayX, 
        overlayY 
      };
      e.stopPropagation();
    }
  };

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!isDraggingOverlay) return;
      const dx = e.clientX - overlayDragStart.current.x;
      const dy = e.clientY - overlayDragStart.current.y;
      setOverlayX(overlayDragStart.current.overlayX + dx);
      setOverlayY(overlayDragStart.current.overlayY + dy);
    };

    const handleGlobalTouchMove = (e: TouchEvent) => {
      if (!isDraggingOverlay || e.touches.length === 0) return;
      const dx = e.touches[0].clientX - overlayDragStart.current.x;
      const dy = e.touches[0].clientY - overlayDragStart.current.y;
      setOverlayX(overlayDragStart.current.overlayX + dx);
      setOverlayY(overlayDragStart.current.overlayY + dy);
      if (e.cancelable) e.preventDefault();
    };

    const handleGlobalMouseUp = () => {
      setIsDraggingOverlay(false);
    };

    if (isDraggingOverlay) {
      window.addEventListener('mousemove', handleGlobalMouseMove);
      window.addEventListener('mouseup', handleGlobalMouseUp);
      window.addEventListener('touchmove', handleGlobalTouchMove, { passive: false });
      window.addEventListener('touchend', handleGlobalMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('touchmove', handleGlobalTouchMove);
      window.removeEventListener('touchend', handleGlobalMouseUp);
    };
  }, [isDraggingOverlay]);

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
  // The dial clicks into the angles that were actually checked against the model, so every
  // position it can rest at is one that produces the framing it names. In between those
  // stops the wording is the same anyway — a free 37° and a free 52° both come out as the
  // three-quarter shot — so a dial that stopped there would only promise a precision the
  // result does not have.
  const YAW_STOPS = [-180, -135, -90, -45, -25, 0, 25, 45, 90, 135, 180];
  const PITCH_STOPS = [-75, -45, -20, 0, 20, 45, 75]; // −75 bird's-eye · +75 ant's-eye
  const YAW_PRESETS = [
    { deg: 0, th: 'หน้าตรง' },
    { deg: 25, th: 'หันเล็กน้อย' },
    { deg: 45, th: 'สามส่วนสี่' },
    { deg: 90, th: 'ด้านข้าง' },
    { deg: 135, th: 'ค่อนไปหลัง' },
    { deg: 180, th: 'ด้านหลัง' },
  ];
  const PITCH_PRESETS = [
    { deg: -75, th: '🦅 Bird’s eye' },
    { deg: -45, th: 'มุมสูง' },
    { deg: -20, th: 'ก้มเล็กน้อย' },
    { deg: 0, th: '👁 ระดับสายตา' },
    { deg: 20, th: 'เงยเล็กน้อย' },
    { deg: 45, th: 'มุมต่ำ' },
    { deg: 75, th: '🐜 Ant’s eye' },
  ];
  const snapTo = (value: number, stops: number[]) =>
    stops.reduce((best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best), stops[0]);

  const handleSphereMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDraggingSphere(true);
    sphereDragStart.current = { x: e.clientX, y: e.clientY, yaw, pitch };
  };

  const handleSphereTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length > 0) {
      setIsDraggingSphere(true);
      sphereDragStart.current = { 
        x: e.touches[0].clientX, 
        y: e.touches[0].clientY, 
        yaw, 
        pitch 
      };
    }
  };

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!isDraggingSphere) return;
      const dx = e.clientX - sphereDragStart.current.x;
      const dy = e.clientY - sphereDragStart.current.y;
      
      const sensitivity = 0.8; 
      let newYaw = sphereDragStart.current.yaw - dx * sensitivity;
      let newPitch = sphereDragStart.current.pitch + dy * sensitivity;

      if (newYaw > 180) newYaw -= 360;
      if (newYaw < -180) newYaw += 360;
      newPitch = Math.max(-80, Math.min(80, newPitch));

      setYaw(snapTo(newYaw, YAW_STOPS));
      setPitch(snapTo(newPitch, PITCH_STOPS));
    };

    const handleGlobalTouchMove = (e: TouchEvent) => {
      if (!isDraggingSphere || e.touches.length === 0) return;
      const dx = e.touches[0].clientX - sphereDragStart.current.x;
      const dy = e.touches[0].clientY - sphereDragStart.current.y;
      
      const sensitivity = 0.8;
      let newYaw = sphereDragStart.current.yaw - dx * sensitivity;
      let newPitch = sphereDragStart.current.pitch + dy * sensitivity;

      if (newYaw > 180) newYaw -= 360;
      if (newYaw < -180) newYaw += 360;
      newPitch = Math.max(-80, Math.min(80, newPitch));

      setYaw(snapTo(newYaw, YAW_STOPS));
      setPitch(snapTo(newPitch, PITCH_STOPS));

      if (e.cancelable) e.preventDefault();
    };

    const handleGlobalMouseUp = () => {
      setIsDraggingSphere(false);
    };

    if (isDraggingSphere) {
      window.addEventListener('mousemove', handleGlobalMouseMove);
      window.addEventListener('mouseup', handleGlobalMouseUp);
      window.addEventListener('touchmove', handleGlobalTouchMove, { passive: false });
      window.addEventListener('touchend', handleGlobalMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('touchmove', handleGlobalTouchMove);
      window.removeEventListener('touchend', handleGlobalMouseUp);
    };
  }, [isDraggingSphere, yaw, pitch]);

  useEffect(() => {
    let angleLabel = 'default';
    const absYaw = Math.abs(yaw);
    
    // Wording beats numbers here: asking for "25 degrees" turns the subject only slightly
    // and "70 degrees" barely turns it at all, while a named framing lands reliably. Two
    // things make a named step land on the angle the dial shows:
    //  - the steps sit where the photographic terms actually are (45° is the three-quarter,
    //    90° the profile, 180° the back of the head), so the dial and the result agree;
    //  - each one says what becomes VISIBLE at that angle. A model renders what it can
    //    picture, and "one ear and the line of the nose" is far easier to picture than
    //    "near-profile", which it tends to round back toward a face-on shot.
    // Which way the face ends up pointing IN THE FRAME, rather than which side the camera
    // stands on. Both readings of "from the right side" are defensible, and the model was
    // picking its own — measured side by side, naming the edge of the frame the nose points
    // at flips the result every time. Orbiting the camera toward the viewer's right (the
    // dot dragged right, yaw negative) leaves the subject facing the left edge.
    const facing = yaw > 0 ? 'right' : 'left';
    const cheek = yaw > 0 ? 'left' : 'right';
    let yawLabel = 'straight-on front view, the face square to the camera';
    if (absYaw > 12 && absYaw <= 35) {
      yawLabel = `front view with the head turned slightly toward the ${facing} edge of the frame, both eyes still fully visible`;
    } else if (absYaw > 35 && absYaw <= 65) {
      yawLabel = `classic three-quarter view, the face angled toward the ${facing} edge of the frame so the camera sees the ${cheek} cheek, about three quarters of the face showing and the nose breaking the line of the far cheek`;
    } else if (absYaw > 65 && absYaw <= 115) {
      yawLabel = `full 90-degree side profile in which the subject faces the ${facing} edge of the frame — the nose, lips and chin point that way and the camera sees the ${cheek} ear and ${cheek} cheek, with the outline of the forehead, nose and chin drawn against the background`;
    } else if (absYaw > 115 && absYaw <= 155) {
      yawLabel = `rear three-quarter view, seen mostly from behind with the head turned toward the ${facing} edge of the frame: the back and ${cheek} side of the head fill the frame, only a sliver of cheek and eyelash showing past it`;
    } else if (absYaw > 155) {
      yawLabel = `view from directly behind the subject, the back of the head and the shoulders facing the camera, the face not visible at all`;
    }

    // Graded the same way, for the same reason: "looking down" alone lands as a faint tilt.
    // The two extremes name what ends up behind the subject — floor for the bird's-eye,
    // ceiling for the ant's-eye — which is what tells the model how far the camera moved.
    const absPitch = Math.abs(pitch);
    const up = pitch > 0; // the camera is below the subject, aimed upward
    let pitchLabel = 'camera at eye level';
    if (absPitch > 10 && absPitch <= 32) {
      pitchLabel = up
        ? 'camera slightly below eye level, looking gently up at the subject'
        : 'camera slightly above eye level, looking gently down at the subject';
    } else if (absPitch > 32 && absPitch <= 60) {
      pitchLabel = up
        ? 'strong low angle, the camera around chest height aimed steeply up so the jawline and the underside of the chin are visible'
        : 'strong high angle, the camera well above the head aimed steeply down so the top of the head and the shoulders dominate the frame';
    } else if (absPitch > 60) {
      pitchLabel = up
        ? "extreme worm's-eye (ant's-eye) view: the camera is down near floor level looking steeply up at the subject, so the underside of the chin and jawline are visible and the ceiling appears behind the head"
        : "extreme bird's-eye view: the camera is high above the subject looking steeply down, the top of the head and the shoulders dominating the frame, the face strongly foreshortened, the floor visible behind the subject";
    }

    if (yaw !== 0 || pitch !== 0) {
      angleLabel = `${yawLabel}, ${pitchLabel}`;
    }
    setCameraAngle(angleLabel);
  }, [yaw, pitch]);

  useEffect(() => {
    const canvas = joystickCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const cx = width / 2;
    const cy = height / 2;
    const radius = 60;

    ctx.clearRect(0, 0, width, height);

    const radYaw = (-yaw * Math.PI) / 180;
    const radPitch = (pitch * Math.PI) / 180;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    ctx.fillStyle = '#1A1A1D';
    ctx.fill();

    const gradient = ctx.createRadialGradient(
      cx - radius / 3,
      cy - radius / 3,
      radius / 8,
      cx,
      cy,
      radius
    );
    gradient.addColorStop(0, '#5A5A62');
    gradient.addColorStop(0.3, '#2A2A2E');
    gradient.addColorStop(0.8, '#131316');
    gradient.addColorStop(1, '#08080A');
    
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    ctx.fillStyle = gradient;
    ctx.fill();

    const project = (lat: number, lon: number) => {
      const x = Math.cos(lat) * Math.sin(lon);
      const y = Math.sin(lat);
      const z = Math.cos(lat) * Math.cos(lon);

      const y1 = y * Math.cos(radPitch) - z * Math.sin(radPitch);
      const z1 = y * Math.sin(radPitch) + z * Math.cos(radPitch);
      const x1 = x;

      const x2 = x1 * Math.cos(radYaw) + z1 * Math.sin(radYaw);
      const z2 = -x1 * Math.sin(radYaw) + z1 * Math.cos(radYaw);
      const y2 = y1;

      return {
        x: cx + x2 * radius,
        y: cy - y2 * radius,
        visible: z2 > 0
      };
    };

    ctx.lineWidth = 1;
    for (let lonDeg = -180; lonDeg < 180; lonDeg += 30) {
      const lonRad = (lonDeg * Math.PI) / 180;
      ctx.beginPath();
      let first = true;
      for (let latDeg = -90; latDeg <= 90; latDeg += 5) {
        const latRad = (latDeg * Math.PI) / 180;
        const pt = project(latRad, lonRad);
        if (pt.visible) {
          if (first) {
            ctx.moveTo(pt.x, pt.y);
            first = false;
          } else {
            ctx.lineTo(pt.x, pt.y);
          }
        } else {
          first = true;
        }
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.stroke();
    }

    for (let latDeg = -60; latDeg <= 60; latDeg += 30) {
      const latRad = (latDeg * Math.PI) / 180;
      ctx.beginPath();
      let first = true;
      for (let lonDeg = -180; lonDeg <= 180; lonDeg += 5) {
        const lonRad = (lonDeg * Math.PI) / 180;
        const pt = project(latRad, lonRad);
        if (pt.visible) {
          if (first) {
            ctx.moveTo(pt.x, pt.y);
            first = false;
          } else {
            ctx.lineTo(pt.x, pt.y);
          }
        } else {
          first = true;
        }
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.stroke();
    }

    ctx.beginPath();
    let firstEquator = true;
    for (let lonDeg = -180; lonDeg <= 180; lonDeg += 5) {
      const lonRad = (lonDeg * Math.PI) / 180;
      const pt = project(0, lonRad);
      if (pt.visible) {
        if (firstEquator) {
          ctx.moveTo(pt.x, pt.y);
          firstEquator = false;
        } else {
          ctx.lineTo(pt.x, pt.y);
        }
      } else {
        firstEquator = true;
      }
    }
    ctx.strokeStyle = 'rgba(212, 175, 55, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const cameraPt = project(0, 0);
    if (cameraPt.visible) {
      ctx.beginPath();
      ctx.arc(cameraPt.x, cameraPt.y, 6, 0, 2 * Math.PI);
      ctx.fillStyle = '#D4AF37';
      ctx.shadowColor = '#D4AF37';
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.beginPath();
      ctx.arc(cameraPt.x, cameraPt.y, 3, 0, 2 * Math.PI);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [yaw, pitch]);

  const resetJoystick = () => {
    setYaw(0);
    setPitch(0);
    setCameraAngle('default');
  };

  const enhancePromptWithAI = async () => {
    if (enhancing) return;
    setEnhancing(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const formData = new FormData();
      formData.append('prompt', prompt);
      formData.append('type', 'image');
      if (uploadedImage) {
        formData.append('image', uploadedImage);
      }
      const res = await fetch('/api/generate-prompt', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success && data.prompt) {
        setPrompt(data.prompt);
        setSuccessMsg('✨ ปรับแต่งรายละเอียดด้วย AI สำเร็จ!');
      } else {
        setErrorMsg(data.error || 'เขียน Prompt ด้วย AI ไม่สำเร็จ');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อระบบ AI');
    } finally {
      setEnhancing(false);
    }
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
      formData.set('skip_enhance', String(skipEnhance));
      formData.set('visual_style', visualStyle);
      formData.set('camera_angle', cameraAngle);
      formData.set('camera_zoom', cameraZoom);
      formData.set('restore_face', String(restoreFace));
      // The viewpoint turn has no purpose-built endpoint, so "ตามโหมด" means Flux 2 Pro there
      formData.set('edit_model', imageMode === 'camera' && editModel === 'auto' ? 'flux2' : editModel);
      formData.set('character_id', characterId);
      formData.set('user_email', user?.email || '');
      formData.set('user_id', user?.id || '');
      formData.set('aspect_ratio', aspectRatio);
      formData.set('strength', strength.toString());
      // The dial position itself, so "สร้างอีกครั้ง" can put the dial back where it was
      formData.set('camera_yaw', String(yaw));
      formData.set('camera_pitch', String(pitch));

      // Prepare Inpainting Blobs
      if (imageMode === 'inpainting') {
        let finalImageFile: File = uploadedImage!;
        let finalMaskFile: File | null = null;

        if (overlayImagePreview) {
          const mainImg = imageRef.current!;
          const overlayImg = new Image();
          overlayImg.src = overlayImagePreview;
          overlayImg.crossOrigin = 'anonymous';
          await new Promise((res) => { overlayImg.onload = res; });

          const naturalW = mainImg.naturalWidth;
          const naturalH = mainImg.naturalHeight;
          const displayW = mainImg.clientWidth;
          const displayH = mainImg.clientHeight;
          const ratioX = naturalW / displayW;
          const ratioY = naturalH / displayH;

          // Create Composite Image Canvas
          const compCanvas = document.createElement('canvas');
          compCanvas.width = naturalW;
          compCanvas.height = naturalH;
          const compCtx = compCanvas.getContext('2d')!;

          compCtx.drawImage(mainImg, 0, 0, naturalW, naturalH);

          const drawW = naturalW * 0.4 * overlayScale;
          const drawH = (overlayImg.naturalHeight / overlayImg.naturalWidth) * drawW;
          
          const screenX = displayW * 0.3 + overlayX;
          const screenY = displayH * 0.3 + overlayY;
          
          const centerX = (screenX + (displayW * 0.4 * overlayScale) / 2) * ratioX;
          const centerY = (screenY + (displayH * 0.4 * overlayScale * (overlayImg.naturalHeight / overlayImg.naturalWidth)) / 2) * ratioY;

          compCtx.save();
          compCtx.translate(centerX, centerY);
          compCtx.rotate((overlayRotate * Math.PI) / 180);
          compCtx.drawImage(overlayImg, -drawW / 2, -drawH / 2, drawW, drawH);
          compCtx.restore();

          const compBlob = await new Promise<Blob | null>((res) => compCanvas.toBlob(res, 'image/png'));
          if (compBlob) {
            finalImageFile = new File([compBlob], 'composite.png', { type: 'image/png' });
          }

          // Create Mask Canvas
          const maskCanvasElement = document.createElement('canvas');
          maskCanvasElement.width = naturalW;
          maskCanvasElement.height = naturalH;
          const mCtx = maskCanvasElement.getContext('2d')!;

          mCtx.fillStyle = 'black';
          mCtx.fillRect(0, 0, naturalW, naturalH);

          mCtx.save();
          mCtx.translate(centerX, centerY);
          mCtx.rotate((overlayRotate * Math.PI) / 180);
          mCtx.drawImage(overlayImg, -drawW / 2, -drawH / 2, drawW, drawH);
          mCtx.globalCompositeOperation = 'source-in';
          mCtx.fillStyle = 'white';
          mCtx.fillRect(-drawW / 2, -drawH / 2, drawW, drawH);
          mCtx.restore();

          mCtx.globalCompositeOperation = 'source-over';
          
          const drawCanvas = canvasRef.current!;
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = naturalW;
          tempCanvas.height = naturalH;
          const tempCtx = tempCanvas.getContext('2d')!;
          tempCtx.drawImage(drawCanvas, 0, 0, naturalW, naturalH);

          const imgData = tempCtx.getImageData(0, 0, naturalW, naturalH);
          for (let i = 0; i < imgData.data.length; i += 4) {
            if (imgData.data[i + 3] > 0) {
              imgData.data[i] = 255;
              imgData.data[i + 1] = 255;
              imgData.data[i + 2] = 255;
              imgData.data[i + 3] = 255;
            }
          }
          tempCtx.putImageData(imgData, 0, 0);
          mCtx.drawImage(tempCanvas, 0, 0);

          const maskBlob = await new Promise<Blob | null>((res) => maskCanvasElement.toBlob(res, 'image/png'));
          if (maskBlob) {
            finalMaskFile = new File([maskBlob], 'mask.png', { type: 'image/png' });
          }
        } else {
          const maskCanvasElement = document.createElement('canvas');
          maskCanvasElement.width = canvasRef.current!.width;
          maskCanvasElement.height = canvasRef.current!.height;
          const mCtx = maskCanvasElement.getContext('2d')!;
          mCtx.fillStyle = 'black';
          mCtx.fillRect(0, 0, maskCanvasElement.width, maskCanvasElement.height);

          const drawCanvas = canvasRef.current!;
          mCtx.drawImage(drawCanvas, 0, 0);
          
          const imgData = mCtx.getImageData(0, 0, maskCanvasElement.width, maskCanvasElement.height);
          for (let i = 0; i < imgData.data.length; i += 4) {
            if (imgData.data[i + 3] > 0) {
              imgData.data[i] = 255;
              imgData.data[i + 1] = 255;
              imgData.data[i + 2] = 255;
              imgData.data[i + 3] = 255;
            }
          }
          mCtx.putImageData(imgData, 0, 0);

          const maskBlob = await new Promise<Blob | null>((res) => maskCanvasElement.toBlob(res, 'image/png'));
          if (maskBlob) {
            finalMaskFile = new File([maskBlob], 'mask.png', { type: 'image/png' });
          }
        }

        formData.set('image', finalImageFile);
        if (finalMaskFile) {
          formData.set('mask', finalMaskFile);
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

      // A phone photo alone can exceed the request body limit and come back as 413, so move
      // any image out of the request: upload it to storage here and send its URL instead.
      // Storage upload rules may not grant the browser write access, so this is an
      // optimisation, not a requirement: if it doesn't work the picture rides along in
      // the request as before, which is safe because it has already been shrunk.
      const moveFileToStorage = async (field: 'image' | 'mask') => {
        const file = formData.get(field);
        if (!(file instanceof File) || file.size === 0 || !supabase) return;
        try {
          const ext = file.name.split('.').pop() || 'png';
          const storagePath = `images/${user?.email || 'unknown'}/${Date.now()}_${field}.${ext}`;
          const { error: upErr } = await supabase.storage
            .from('kruth-ai-assets')
            .upload(storagePath, file, { upsert: true, contentType: file.type });
          if (upErr) throw upErr;
          const { data: { publicUrl } } = supabase.storage.from('kruth-ai-assets').getPublicUrl(storagePath);
          formData.delete(field);
          formData.set(`${field}_url`, publicUrl);
        } catch (err: any) {
          console.warn(`[${field}] browser upload unavailable, sending the file instead:`, err?.message || err);
        }
      };

      // Only the mask-based flows above build their own composite. Every other mode that
      // edits an existing picture still needs the source attached — without this the
      // request arrives with no image at all while the preview shows one on screen.
      if (imageMode !== 'text_to_image' && !formData.get('image') && !formData.get('image_url')) {
        if (!uploadedImage) {
          throw new Error('โหมดนี้ต้องมีรูปต้นฉบับ กรุณาอัปโหลดรูปก่อนสร้าง');
        }
        formData.set('image', uploadedImage);
      }

      setProgressMessage('กำลังอัปโหลดรูปภาพ...');
      await moveFileToStorage('image');
      await moveFileToStorage('mask');

      // Submit generation call to backend API
      setProgressMessage('กำลังส่งคำสั่งไปยังระบบ AI...');
      const response = await fetch('/api/generate-image', {
        method: 'POST',
        body: formData
      });

      const resJson = await readJsonOrExplain(response);
      if (!response.ok || !resJson.success) {
        throw new Error(resJson.error || 'เกิดข้อผิดพลาดในการสั่งงานไปยังระบบคลาวด์');
      }

      const { requestId, videoPath, modelEndpoint } = resJson;
      setProgressMessage('กำลังต่อคิวรันภาพบนเซิร์ฟเวอร์ AI...');
      setProgressPercent(40);

      // Start Polling loop using video-status (since it's now updated to support images)
      let checkCount = 0;
      let failCount = 0;
      // Hard cap so the spinner can never hang forever: 3s interval × 120 = 6 นาที
      const MAX_CHECKS = 120;
      const intervalId = setInterval(async () => {
        checkCount++;
        if (checkCount > MAX_CHECKS) {
          clearInterval(intervalId);
          setErrorMsg('หมดเวลารอผลลัพธ์ (เกิน 6 นาที) ระบบ AI อาจมีปัญหาชั่วคราว กรุณาลองใหม่อีกครั้ง');
          setLoading(false);
          return;
        }
        try {
          const statusRes = await fetch('/api/video-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requestId,
              videoPath,
              modelType: modelType.includes('flux') ? modelType : 'flux_dev',
              modelEndpoint, // exact Fal endpoint from generate-image → correct queue namespace (fixes schnell/i2i hang)
              storageProvider: 'supabase'
            })
          });

          if (!statusRes.ok) {
            failCount++;
            // Say what actually went wrong: a bare "connection failed" gave no way to tell a
            // timeout from a bad request, and the same reason repeats on every retry.
            let reason = `HTTP ${statusRes.status}`;
            try {
              const body = await statusRes.text();
              const parsed = body.trim().startsWith('{') ? JSON.parse(body) : null;
              reason = parsed?.error ? `${parsed.error} (HTTP ${statusRes.status})` : `${reason} ${body.slice(0, 90)}`;
            } catch {
              /* keep the status code */
            }
            console.warn(`[Image status] attempt ${failCount}/5 failed: ${reason}`);
            if (failCount >= 5) {
              clearInterval(intervalId);
              setErrorMsg(`ตรวจสถานะไม่สำเร็จติดต่อกัน — ${reason}`);
              setLoading(false);
            }
            return;
          }

          failCount = 0;

          const contentType = statusRes.headers.get('content-type') || '';
          if (!contentType.includes('application/json')) {
            const errText = await statusRes.text().catch(() => '');
            throw new Error(errText.substring(0, 100) || 'เซิร์ฟเวอร์ไม่ได้ส่งข้อมูลรูปแบบ JSON');
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

      {whitelistData && (
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4 bg-black/30 p-4 rounded-2xl border border-white/5 shadow-md font-thai text-sm text-text-secondary mb-6">
          <div className="flex flex-col items-center sm:items-start text-center sm:text-left gap-1">
            <span className="font-semibold text-white">สถานะสิทธิ์การใช้งาน (Whitelist Status)</span>
            <div className="flex flex-col sm:flex-row items-center gap-1 sm:gap-2 text-xs text-text-muted">
              <span>วันหมดอายุ: {whitelistData.expires_at ? new Date(whitelistData.expires_at).toLocaleDateString('th-TH') : 'ถาวร (Permanent)'}</span>
              {whitelistData.expires_at && (
                <span className="text-[#D4AF37]">
                  ({(() => {
                    const expiry = new Date(whitelistData.expires_at);
                    const diffMs = expiry.getTime() - Date.now();
                    if (diffMs <= 0) return 'หมดอายุ';
                    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
                    return `เหลือเวลาอีกประมาณ ${diffDays} วัน`;
                  })()})
                </span>
              )}
            </div>
          </div>
          
          <div className="bg-black/50 px-4 py-2.5 rounded-xl border border-white/5 flex flex-col items-center justify-center w-full sm:w-auto shadow-inner text-center">
            <span className="text-[10px] text-text-muted font-medium">ยอดเครดิตสะสมคงเหลือ</span>
            <p className="text-base font-bold text-[#D4AF37] font-mono">
              {((whitelistData.generation_limit || 0) / 10).toFixed(1).replace('.0', '')} เครดิต
            </p>
            <span className="text-[10px] text-accent-success">
              (ใช้หักตามโมเดลและระยะเวลา)
            </span>
          </div>
        </div>
      )}

      {/* Mode Sub-Tabs */}
      <div className="grid grid-cols-4 gap-1.5 p-1 bg-[#1A1A1D] rounded-xl border border-white/5 mb-6">
        {(['text_to_image', 'image_to_image', 'kontext', 'camera', 'relight', 'colorgrade', 'bgreplace', 'upscale', 'inpainting', 'outpainting'] as const).map((mode) => (
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
            {mode === 'kontext' && '✨ แก้ภาพตามคำสั่ง'}
            {mode === 'camera' && '🎥 หมุนมุมกล้อง'}
            {mode === 'bgreplace' && '🖼️ เปลี่ยนพื้นหลัง'}
            {mode === 'upscale' && '🔍 เพิ่มความคมชัด'}
            {mode === 'relight' && '💡 ปรับแสง'}
            {mode === 'colorgrade' && '🎨 เกลี่ยสี'}
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
            <div className="flex justify-between items-center mb-1.5">
              <label className="block text-xs font-semibold text-text-secondary uppercase">
                ✍️ คำอธิบายรายละเอียดภาพ (Prompt) *
              </label>
              <button
                type="button"
                onClick={enhancePromptWithAI}
                disabled={enhancing}
                className="flex items-center gap-1.5 text-[10px] sm:text-xs font-bold text-[#D4AF37] hover:text-[#D4AF37]/80 disabled:opacity-50 transition-colors cursor-pointer bg-transparent border-0 outline-none"
              >
                {enhancing ? (
                  <Loader2 className="w-3 h-3 animate-spin text-text-muted" />
                ) : (
                  <Wand2 className="w-3 h-3" />
                )}
                ให้ AI ช่วยเขียน Prompt
              </button>
            </div>
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

          {/* Skip AI prompt enhancement — saves tokens for users who write their own detailed prompt */}
          <label className="flex items-center gap-2 mb-4 cursor-pointer select-none text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={skipEnhance}
              onChange={(e) => setSkipEnhance(e.target.checked)}
              className="accent-[#D4AF37] w-4 h-4"
            />
            ✍️ ใช้ Prompt ของฉันตรงๆ (ข้ามการปรับแต่งด้วย AI — ประหยัด Token)
          </label>

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
                <button
                  type="button"
                  onClick={() => setModelType('flux2pro')}
                  disabled={!!characterId}
                  title={characterId ? 'Flux 2 Pro ยังใช้ตัวละครที่เทรนไว้ (LoRA ของ Flux 1) ไม่ได้' : undefined}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                    modelType === 'flux2pro' ? 'bg-white text-black shadow-md' : 'text-text-muted hover:text-white'
                  }`}
                >
                  ✨ Flux 2 Pro (รุ่นใหม่สุด)
                </button>
                <button
                  type="button"
                  onClick={() => setModelType('grok')}
                  disabled={!!characterId}
                  title={characterId ? 'Grok ยังใช้ตัวละครที่เทรนไว้ไม่ได้' : undefined}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                    modelType === 'grok' ? 'bg-white text-black shadow-md' : 'text-text-muted hover:text-white'
                  }`}
                >
                  🤖 Grok (ฉากไทยสมจริง)
                </button>
              </div>
              {modelType === 'grok' && (
                <p className="text-[10px] text-text-muted leading-relaxed">
                  จากที่ทดสอบ Grok ทำ<b>ฉากห้องเรียนไทยและตัวอักษรไทยได้เป็นธรรมชาติกว่า</b> แต่ใช้ร่วมกับตัวละครที่เทรนไว้ไม่ได้
                </p>
              )}
            </div>

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
                  onChange={(e) => {
                    setCharacterId(e.target.value);
                    // Grok cannot load a Flux LoRA, so picking a character while it is
                    // selected would be refused on submit. Step back to Dev instead.
                    if (e.target.value && (modelType === 'grok' || modelType === 'flux2pro')) setModelType('flux_dev');
                  }}
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

          {/* One picker for every mode that works by instructing a model, rather than one
              that only the viewpoint turn could reach. Left on "ตามโหมด" each mode keeps
              the purpose-built endpoint it has always used. */}
          {EDIT_CAPABLE_MODES.includes(imageMode) && (
            <div className="space-y-1.5 p-4 rounded-xl bg-[#1C1C1E] border border-white/10">
              <label className="block text-xs font-semibold text-text-secondary uppercase">
                🤖 โมเดล AI ที่ใช้แก้ภาพ (Editing Model)
              </label>
              <select
                value={imageMode === 'camera' && editModel === 'auto' ? 'flux2' : editModel}
                onChange={(e) => setEditModel(e.target.value as typeof editModel)}
                className="w-full bg-black border border-white/10 p-2.5 rounded-lg text-xs text-white outline-none cursor-pointer"
              >
                {imageMode !== 'camera' && (
                  <option value="auto">🎯 ตามโหมด — โมเดลเฉพาะทาง (แนะนำ / ถูกที่สุด)</option>
                )}
                {EDIT_MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label} ({m.credits} เครดิต)</option>
                ))}
              </select>
              <p className="text-[10px] text-text-muted leading-relaxed">
                {imageMode === 'camera'
                  ? <>รุ่นแพงกว่าให้ภาพคมกว่า แต่จากที่ทดสอบมัก<b>ปรับหน้าให้สวยขึ้นจนเหมือนต้นฉบับน้อยลง</b></>
                  : <>โหมดนี้มีโมเดลเฉพาะทางอยู่แล้วซึ่งถูกและนิ่งกว่า — เลือกรุ่นอื่นเมื่อ<b>ผลออกมาไม่ถูกใจ หรือคำสั่งซับซ้อนกว่าที่โมเดลเดิมรับไหว</b></>}
              </p>
            </div>
          )}

          {/* Orbit controls belong to the mode that can actually turn a viewpoint */}
          {imageMode === 'camera' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-xl bg-[#1C1C1E] border border-white/10">
            <div className="flex flex-col items-center justify-center space-y-3">
              <label className="text-xs font-semibold text-text-secondary uppercase text-center w-full">
                🔄 หมุนคันโยกปรับทิศทางมุมกล้อง (Camera Orbit)
              </label>
              <canvas
                ref={joystickCanvasRef}
                width={144}
                height={144}
                onMouseDown={handleSphereMouseDown}
                onTouchStart={handleSphereTouchStart}
                className="w-36 h-36 rounded-full bg-black border border-white/10 cursor-grab active:cursor-grabbing shadow-inner"
              />
              <button
                type="button"
                onClick={resetJoystick}
                className="text-[10px] text-text-muted hover:text-white transition-colors"
              >
                🔄 รีเซ็ตมุมกล้องปกติ
              </button>

              {Math.abs(yaw) > 115 && (
                <p className="mt-1.5 text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2 py-1.5 leading-relaxed">
                  ⚠️ เกิน 115° จะเห็นหน้าเพียงเสี้ยวเดียวหรือไม่เห็นเลย ภาพจะหมุนตามจริง
                  แต่<b>เทียบความเหมือนไม่ได้</b> เพราะด้านหลังศีรษะไม่มีอยู่ในรูปต้นฉบับ โมเดลจะเดาเอง
                </p>
              )}

              <label className="mt-2 flex items-start gap-2 cursor-pointer text-left">
                <input
                  type="checkbox"
                  checked={restoreFace}
                  onChange={(e) => setRestoreFace(e.target.checked)}
                  className="mt-0.5 accent-[#D4AF37]"
                />
                <span className="text-[10px] text-text-muted leading-relaxed">
                  <b className="text-text-secondary">คืนใบหน้าต้นฉบับหลังหมุน</b> — ทับใบหน้าเดิมลงบนภาพที่หมุนแล้ว
                  หน้าจะเหมือนต้นฉบับมากขึ้น แต่บางครั้งดูแข็งหรือไม่กลืนกับแสงในภาพ
                  ถ้าอยากได้ภาพที่ดูเป็นธรรมชาติกว่า ให้ปิดตัวเลือกนี้
                </span>
              </label>

            </div>

            <div className="space-y-4 flex flex-col justify-center">
              <div>
                <span className="text-[10px] text-text-muted font-bold block mb-1">มุมกล้องที่เลือกอยู่:</span>
                <span
                  title={cameraAngle}
                  className="text-xs text-[#D4AF37] font-semibold block bg-black/40 p-2 rounded-lg border border-white/5"
                >
                  📸 {YAW_PRESETS.find((p) => p.deg === Math.abs(yaw))?.th ?? 'หน้าตรง'}
                  {yaw !== 0 && (yaw > 0 ? ' (หันไปทางขวา)' : ' (หันไปทางซ้าย)')}
                  {' · '}
                  {PITCH_PRESETS.find((p) => p.deg === pitch)?.th ?? 'ระดับสายตา'}
                </span>
                <span className="text-[9px] text-text-muted mt-1 block font-mono">
                  Yaw (หมุนซ้าย-ขวา): {Math.round(yaw)}° | Pitch (ก้ม-เงย): {Math.round(pitch)}°
                </span>
              </div>

              {/* Every chip is a stop the dial can rest at, and each one was checked against
                  the model before being offered here. */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-[10px] font-bold text-text-secondary uppercase">
                    ↔️ หมุนซ้าย–ขวา (Yaw)
                  </label>
                  <button
                    type="button"
                    onClick={() => setYaw(-yaw)}
                    disabled={yaw === 0}
                    className="text-[10px] text-text-muted hover:text-white disabled:opacity-30 transition-colors"
                  >
                    ⇄ สลับด้าน
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {YAW_PRESETS.map((p) => (
                    <button
                      key={p.deg}
                      type="button"
                      onClick={() => setYaw(yaw < 0 ? -p.deg : p.deg)}
                      className={`px-1.5 py-1.5 rounded-lg text-[10px] leading-tight border transition-colors ${
                        Math.abs(yaw) === p.deg
                          ? 'bg-[#D4AF37]/20 border-[#D4AF37]/60 text-[#D4AF37] font-semibold'
                          : 'bg-black border-white/10 text-text-muted hover:text-white hover:border-white/25'
                      }`}
                    >
                      {p.th}
                      <span className="block font-mono text-[9px] opacity-60">{p.deg}°</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-[10px] font-bold text-text-secondary uppercase">
                  ↕️ ก้ม–เงย (Pitch)
                </label>
                <div className="grid grid-cols-3 gap-1">
                  {PITCH_PRESETS.map((p) => (
                    <button
                      key={p.deg}
                      type="button"
                      onClick={() => setPitch(p.deg)}
                      className={`px-1.5 py-1.5 rounded-lg text-[10px] leading-tight border transition-colors ${
                        pitch === p.deg
                          ? 'bg-[#D4AF37]/20 border-[#D4AF37]/60 text-[#D4AF37] font-semibold'
                          : 'bg-black border-white/10 text-text-muted hover:text-white hover:border-white/25'
                      }`}
                    >
                      {p.th}
                      <span className="block font-mono text-[9px] opacity-60">{p.deg}°</span>
                    </button>
                  ))}
                </div>
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
          )}

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
                <span>สร้างรูปภาพผลลัพธ์ (หัก 2 เครดิต)</span>
              </>
            )}
          </button>
        </div>

        {/* Right column: Previews / Interactive canvases */}
        <div className="lg:col-span-5 flex flex-col justify-start">
          {imageMode === 'text_to_image' ? (
            <div className={`border border-white/10 rounded-2xl bg-black/30 overflow-hidden flex flex-col justify-center items-center p-6 border-dashed transition-all duration-300 w-full self-center ${getContainerAspectClass()}`}>
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
                <div className="space-y-3 w-full self-center flex flex-col items-center">
                  <div className={`relative border border-white/10 rounded-2xl bg-[#0F0F11] overflow-hidden flex items-center justify-center p-4 transition-all duration-300 w-full self-center ${getContainerAspectClass()}`}>
                    {/* Modes that edit the picture as a whole simply show it. Only the
                        mask-based modes below need their own canvas. */}
                    {['image_to_image', 'kontext', 'camera', 'relight', 'colorgrade', 'bgreplace', 'upscale'].includes(imageMode) && (
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
                        
                        {overlayImagePreview && (
                          <div
                            onMouseDown={handleOverlayDragStart}
                            onTouchStart={handleOverlayTouchStart}
                            style={{
                              transform: `translate(${overlayX}px, ${overlayY}px) rotate(${overlayRotate}deg) scale(${overlayScale})`,
                              cursor: isDraggingOverlay ? 'grabbing' : 'grab',
                              position: 'absolute',
                              left: '30%',
                              top: '30%',
                              width: '40%',
                              zIndex: 10,
                              touchAction: 'none'
                            }}
                            className="select-none active:scale-[1.01] transition-transform duration-75 border-2 border-dashed border-[#D4AF37]/50 rounded-lg hover:border-[#D4AF37]"
                          >
                            <img
                              src={overlayImagePreview}
                              alt="Overlay object"
                              className="w-full h-auto pointer-events-none select-none"
                            />
                          </div>
                        )}

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
                          className="cursor-move border border-[#D4AF37]/30 rounded-xl shadow-lg max-w-full max-h-[280px] object-contain"
                        />
                        <span className="text-[10px] text-text-muted mt-2 block flex items-center gap-1">
                          <Move className="w-3 h-3" /> ลากเมาส์ขยับตำแหน่งรูปในเฟรมด้านบน
                        </span>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={clearUploadedImage}
                      className="absolute top-3 right-3 p-2 rounded-lg bg-black/60 hover:bg-black text-text-muted hover:text-white border border-white/10 transition-colors"
                      title="ลบรูปภาพ"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Canvas controls for Inpainting */}
                  {imageMode === 'inpainting' && (
                    <div className="p-4 bg-[#1C1C1E] rounded-xl border border-white/10 space-y-4 w-full">
                      {/* Upload zone for secondary overlay */}
                      <div className="space-y-1.5 border-b border-white/5 pb-3">
                        <span className="text-[10px] font-bold text-text-secondary uppercase block">➕ แนบภาพวัตถุเพิ่มเติมเพื่อตัดต่อซ้อน (Composite Inpaint)</span>
                        <div className="flex items-center gap-3">
                          <input
                            type="file"
                            accept="image/*"
                            onChange={handleOverlayUpload}
                            id="overlay-upload"
                            className="hidden"
                          />
                          <label
                            htmlFor="overlay-upload"
                            className="cursor-pointer text-xs bg-[#D4AF37]/15 border border-[#D4AF37]/35 text-[#D4AF37] hover:bg-[#D4AF37]/25 px-3 py-2 rounded-lg flex items-center gap-1.5 transition-colors font-bold"
                          >
                            <ImageIcon className="w-3.5 h-3.5" /> 
                            {overlayFile ? 'เปลี่ยนวัตถุซ้อนทับ' : 'อัปโหลดภาพที่จะนำมาวาง'}
                          </label>
                          
                          {isRemovingBg && (
                            <span className="text-[10px] text-text-muted flex items-center gap-1.5">
                              <Loader2 className="w-3 h-3 animate-spin text-[#D4AF37]" />
                              กำลังลบพื้นหลังด้วย BiRefNet...
                            </span>
                          )}
                          
                          {overlayFile && !isRemovingBg && (
                            <button
                              type="button"
                              onClick={() => {
                                setOverlayFile(null);
                                setOverlayImagePreview('');
                              }}
                              className="text-[10px] text-accent-danger hover:underline font-bold"
                            >
                              ลบรูปภาพซ้อนทับ
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Display sliders only if overlay is active */}
                      {overlayImagePreview && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-b border-white/5 pb-3">
                          <div className="space-y-1">
                            <div className="flex justify-between text-[10px] text-text-muted font-bold">
                              <span>🔍 ซูมวัตถุ (Scale):</span>
                              <span className="text-[#D4AF37] font-mono">{Math.round(overlayScale * 100)}%</span>
                            </div>
                            <input
                              type="range"
                              min="0.1"
                              max="2.5"
                              step="0.05"
                              value={overlayScale}
                              onChange={(e) => setOverlayScale(parseFloat(e.target.value))}
                              className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
                            />
                          </div>
                          
                          <div className="space-y-1">
                            <div className="flex justify-between text-[10px] text-text-muted font-bold">
                              <span>🔄 หมุนวัตถุ (Rotate):</span>
                              <span className="text-[#D4AF37] font-mono">{overlayRotate}°</span>
                            </div>
                            <input
                              type="range"
                              min="-180"
                              max="180"
                              step="5"
                              value={overlayRotate}
                              onChange={(e) => setOverlayRotate(parseInt(e.target.value, 10))}
                              className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
                            />
                          </div>

                          <div className="space-y-1">
                            <div className="flex justify-between text-[10px] text-text-muted font-bold">
                              <span>↕️ ตำแหน่งแกน Y (Vertical):</span>
                              <span className="text-[#D4AF37] font-mono">{overlayY}px</span>
                            </div>
                            <input
                              type="range"
                              min="-250"
                              max="250"
                              step="2"
                              value={overlayY}
                              onChange={(e) => setOverlayY(parseInt(e.target.value, 10))}
                              className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
                            />
                          </div>

                          <div className="space-y-1">
                            <div className="flex justify-between text-[10px] text-text-muted font-bold">
                              <span>↔️ ตำแหน่งแกน X (Horizontal):</span>
                              <span className="text-[#D4AF37] font-mono">{overlayX}px</span>
                            </div>
                            <input
                              type="range"
                              min="-250"
                              max="250"
                              step="2"
                              value={overlayX}
                              onChange={(e) => setOverlayX(parseInt(e.target.value, 10))}
                              className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
                            />
                          </div>
                        </div>
                      )}

                      {/* Brush control */}
                      <div className="flex items-center justify-between gap-3 w-full">
                        <button
                          type="button"
                          onClick={clearMask}
                          className="text-xs bg-black/50 border border-white/10 hover:bg-black text-text-muted hover:text-white px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors font-bold"
                        >
                          <RefreshCw className="w-3 h-3" /> ล้างหน้ากากพู่กัน
                        </button>
                        
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
                <div className={`relative border border-white/10 rounded-2xl bg-black overflow-hidden flex items-center justify-center p-4 transition-all duration-300 w-full self-center ${getContainerAspectClass()}`}>
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
