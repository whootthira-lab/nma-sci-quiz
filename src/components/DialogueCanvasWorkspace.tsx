'use client';

import { useState, useEffect, useRef } from 'react';
import { Loader2, AlertCircle, User, Check, X, RefreshCw } from 'lucide-react';

interface Character {
  id: string;
  name: string;
  avatar_front_url?: string;
}

interface FaceBox {
  id: string;
  boxX: number;      // 0 to 1 relative
  boxY: number;      // 0 to 1 relative
  boxWidth: number;   // 0 to 1 relative
  boxHeight: number;  // 0 to 1 relative
}

export interface FaceTag {
  characterId: string;
  characterName: string;
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
}

interface DialogueCanvasWorkspaceProps {
  imageUrl: string;
  characters: Character[];
  faceTags: FaceTag[];
  onTagsChange: (tags: FaceTag[]) => void;
}

export default function DialogueCanvasWorkspace({
  imageUrl,
  characters,
  faceTags,
  onTagsChange
}: DialogueCanvasWorkspaceProps) {
  const [detector, setDetector] = useState<any>(null);
  const [initializing, setInitializing] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Detected face boxes (without character association yet)
  const [detectedFaces, setDetectedFaces] = useState<FaceBox[]>([]);
  
  // Active dropdown open state for specific box index
  const [activeDropdownBoxId, setActiveDropdownBoxId] = useState<string | null>(null);
  
  const imageRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Initialize MediaPipe FaceDetector vision task dynamically on client-side
  useEffect(() => {
    let active = true;
    
    const initDetector = async () => {
      try {
        setInitializing(true);
        setError(null);
        
        // Dynamic import to avoid Next.js SSR bundling issues
        const vision = await import('@mediapipe/tasks-vision');
        const filesetResolver = await vision.FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/wasm'
        );
        
        const faceDetectorInstance = await vision.FaceDetector.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.task',
            delegate: 'GPU'
          },
          runningMode: 'IMAGE'
        });

        if (active) {
          setDetector(faceDetectorInstance);
          console.log('[DialogueCanvasWorkspace] MediaPipe FaceDetector initialized successfully');
        }
      } catch (err: any) {
        console.error('[DialogueCanvasWorkspace] Failed to initialize MediaPipe:', err);
        if (active) {
          setError('ไม่สามารถโหลด AI สำหรับตรวจจับใบหน้าได้ (อาจเกิดจากการเชื่อมต่ออินเทอร์เน็ต)');
        }
      } finally {
        if (active) {
          setInitializing(false);
        }
      }
    };

    initDetector();

    return () => {
      active = false;
    };
  }, []);

  // Run face detection on image elements
  const runFaceDetection = async () => {
    if (!detector || !imageRef.current) return;

    setDetecting(true);
    setError(null);
    setDetectedFaces([]);

    try {
      const img = imageRef.current;
      
      // Ensure image is fully loaded and has dimension
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        throw new Error('รูปภาพยังโหลดไม่สมบูรณ์');
      }

      // Run inference
      const results = detector.detect(img);
      const imgWidth = img.naturalWidth;
      const imgHeight = img.naturalHeight;

      if (!results || !results.detections || results.detections.length === 0) {
        console.log('[DialogueCanvasWorkspace] No faces found');
        setDetectedFaces([]);
        return;
      }

      const foundFaces: FaceBox[] = results.detections.map((det: any, index: number) => {
        const box = det.boundingBox;
        
        // Convert to percentage values (0 to 1) for responsive rendering
        return {
          id: `face-${index}-${Math.random().toString(36).substring(2, 7)}`,
          boxX: box.originX / imgWidth,
          boxY: box.originY / imgHeight,
          boxWidth: box.width / imgWidth,
          boxHeight: box.height / imgHeight
        };
      });

      setDetectedFaces(foundFaces);
      console.log(`[DialogueCanvasWorkspace] Successfully detected ${foundFaces.length} faces`);
    } catch (err: any) {
      console.error('[DialogueCanvasWorkspace] Detection error:', err);
      setError('เกิดข้อผิดพลาดในการตรวจจับใบหน้าจากรูปภาพ');
    } finally {
      setDetecting(false);
    }
  };

  // Run detection when imageUrl changes or when detector is ready
  useEffect(() => {
    if (detector && imageUrl) {
      // Trigger detection after a short delay to let the image render in the DOM
      const timer = setTimeout(() => {
        if (imageRef.current && imageRef.current.complete) {
          runFaceDetection();
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [detector, imageUrl]);

  // Click handler on face overlay box
  const handleBoxClick = (e: React.MouseEvent, boxId: string) => {
    e.stopPropagation();
    setActiveDropdownBoxId(activeDropdownBoxId === boxId ? null : boxId);
  };

  // Close dropdown on clicking outside
  useEffect(() => {
    const handleOutsideClick = () => {
      setActiveDropdownBoxId(null);
    };
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  // Associate a character with a specific face box coordinates
  const linkCharacterToBox = (box: FaceBox, characterId: string) => {
    const char = characters.find(c => c.id === characterId);
    if (!char) return;

    // Filter out any existing face tag linked to this character, or linked to this box coordinates
    const otherTags = faceTags.filter(
      tag => tag.characterId !== characterId && 
      !(Math.abs(tag.boxX - box.boxX) < 0.01 && Math.abs(tag.boxY - box.boxY) < 0.01)
    );

    const newTag: FaceTag = {
      characterId: char.id,
      characterName: char.name,
      boxX: box.boxX,
      boxY: box.boxY,
      boxWidth: box.boxWidth,
      boxHeight: box.boxHeight
    };

    onTagsChange([...otherTags, newTag]);
    setActiveDropdownBoxId(null);
  };

  // Unlink a character from a face box
  const unlinkBox = (box: FaceBox) => {
    const remainingTags = faceTags.filter(
      tag => !(Math.abs(tag.boxX - box.boxX) < 0.01 && Math.abs(tag.boxY - box.boxY) < 0.01)
    );
    onTagsChange(remainingTags);
    setActiveDropdownBoxId(null);
  };

  // Match box to any existing linked tag
  const getLinkedTagForBox = (box: FaceBox): FaceTag | undefined => {
    return faceTags.find(
      tag => Math.abs(tag.boxX - box.boxX) < 0.01 && Math.abs(tag.boxY - box.boxY) < 0.01
    );
  };

  return (
    <div className="space-y-4">
      {/* Loading Overlay */}
      {initializing && (
        <div className="flex flex-col items-center justify-center py-12 bg-gray-50 border border-gray-150 rounded-2xl">
          <Loader2 className="w-8 h-8 text-[#D4AF37] animate-spin mb-2" />
          <p className="text-sm text-gray-500 font-thai">กำลังเตรียมความพร้อม AI ตรวจจับใบหน้า...</p>
        </div>
      )}

      {/* Main Work Area */}
      {!initializing && (
        <div className="space-y-3">
          {/* Header Actions */}
          <div className="flex justify-between items-center bg-gray-50 border border-gray-150 px-4 py-2.5 rounded-xl">
            <span className="text-xs font-semibold text-gray-600 font-thai flex items-center gap-1.5">
              {detecting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 text-[#D4AF37] animate-spin" />
                  <span>กำลังค้นหาใบหน้าตัวละคร...</span>
                </>
              ) : (
                <>
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  <span>ตรวจจับพบ {detectedFaces.length} ใบหน้าในฉาก</span>
                </>
              )}
            </span>
            
            <button
              onClick={runFaceDetection}
              disabled={detecting}
              className="text-xs text-gray-500 hover:text-[#D4AF37] transition-all flex items-center gap-1 font-thai font-medium disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${detecting ? 'animate-spin' : ''}`} />
              ตรวจจับใหม่
            </button>
          </div>

          {/* Canvas Wrapper Box */}
          <div
            ref={containerRef}
            className="relative bg-black/90 rounded-2xl overflow-hidden shadow-inner border border-gray-200 select-none max-w-full mx-auto"
            style={{ width: 'fit-content' }}
          >
            {/* Base Image */}
            <img
              ref={imageRef}
              src={imageUrl}
              alt="Background Scene"
              className="max-h-[500px] w-auto block object-contain mx-auto"
              onLoad={runFaceDetection}
            />

            {/* Clickable Face Overlay Boxes */}
            {detectedFaces.map((face) => {
              const tag = getLinkedTagForBox(face);
              const isLinked = !!tag;
              const isDropdownOpen = activeDropdownBoxId === face.id;

              // Convert percentage values to style string
              const boxStyle = {
                left: `${face.boxX * 100}%`,
                top: `${face.boxY * 100}%`,
                width: `${face.boxWidth * 100}%`,
                height: `${face.boxHeight * 100}%`
              };

              return (
                <div
                  key={face.id}
                  style={boxStyle}
                  onClick={(e) => handleBoxClick(e, face.id)}
                  className={`absolute cursor-pointer border-2 transition-all duration-150 group rounded-lg flex items-center justify-center ${
                    isLinked
                      ? 'border-[#D4AF37] bg-[#D4AF37]/10 hover:bg-[#D4AF37]/20 shadow-[0_0_10px_rgba(212,175,55,0.4)]'
                      : 'border-white/50 border-dashed hover:border-white hover:bg-white/10'
                  }`}
                >
                  {/* Speaker Label Indicator */}
                  {isLinked ? (
                    <div className="absolute -bottom-7 left-1/2 transform -translate-x-1/2 bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37]/30 px-2 py-0.5 rounded text-[10px] font-bold whitespace-nowrap shadow-md font-thai flex items-center gap-1 z-10 animate-fade-in">
                      <Check className="w-2.5 h-2.5 text-green-500" />
                      {tag.characterName}
                    </div>
                  ) : (
                    <div className="opacity-0 group-hover:opacity-100 absolute -bottom-7 left-1/2 transform -translate-x-1/2 bg-black/80 text-white px-2 py-0.5 rounded text-[9px] font-medium whitespace-nowrap shadow font-thai transition-all duration-200 z-10 pointer-events-none">
                      คลิกเพื่อระบุตัวตน
                    </div>
                  )}

                  {/* Character selection Dropdown Box */}
                  {isDropdownOpen && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-full left-1/2 transform -translate-x-1/2 mt-2 w-48 bg-white border border-gray-200 rounded-xl shadow-xl z-20 py-1.5 animate-scale-up text-left"
                    >
                      <p className="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider font-thai border-b border-gray-100 mb-1">
                        ระบุว่าบุคคลนี้คือใคร
                      </p>
                      
                      {characters.map((char) => {
                        // Check if this character is already linked to some other box
                        const isCharLinkedElsewhere = faceTags.some(
                          t => t.characterId === char.id && 
                          !(Math.abs(t.boxX - face.boxX) < 0.01 && Math.abs(t.boxY - face.boxY) < 0.01)
                        );
                        
                        const isCurrentSelection = tag?.characterId === char.id;

                        return (
                          <button
                            key={char.id}
                            onClick={() => linkCharacterToBox(face, char.id)}
                            className={`w-full flex items-center justify-between px-3 py-1.5 text-xs font-thai transition-colors hover:bg-gray-50 ${
                              isCurrentSelection 
                                ? 'text-[#D4AF37] font-semibold bg-amber-50/50' 
                                : 'text-gray-700'
                            }`}
                          >
                            <span className="truncate flex items-center gap-1.5">
                              👤 {char.name}
                            </span>
                            {isCurrentSelection && (
                              <Check className="w-3.5 h-3.5 text-green-500" />
                            )}
                            {isCharLinkedElsewhere && (
                              <span className="text-[9px] bg-gray-100 text-gray-400 px-1 py-0.5 rounded">
                                ย้ายพิกัด
                              </span>
                            )}
                          </button>
                        );
                      })}

                      {isLinked && (
                        <>
                          <div className="border-t border-gray-100 my-1" />
                          <button
                            onClick={() => unlinkBox(face)}
                            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 font-thai text-left transition-colors"
                          >
                            <X className="w-3.5 h-3.5" /> ลบแท็กออก
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Feedback & Instructions */}
          {error && (
            <div className="bg-red-50 border border-red-200 p-3 rounded-xl flex gap-2 text-red-700 text-xs font-thai">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
              <p>{error}</p>
            </div>
          )}

          {detectedFaces.length > 0 && (
            <div className="bg-blue-50/50 border border-blue-100 p-3.5 rounded-2xl text-[11px] text-blue-700 font-thai space-y-1 leading-normal">
              <p className="font-semibold flex items-center gap-1 text-blue-800">
                💡 คำแนะนำในการเชื่อมตัวละคร:
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>คลิกที่กล่องกรอบสี่เหลี่ยมรอบใบหน้าในฉาก เพื่อเลือกชื่อตัวละครที่ต้องการเชื่อมโยง</li>
                <li>ใบหน้าที่เชื่อมโยงจะเปลี่ยนเป็นขอบสีทองและมีป้ายชื่อตัวละครแสดงขึ้นมา</li>
                <li>เมื่อท่านพิมพ์บทพูดและเลือกตัวละครพูดในการ Timeline ด้านล่าง ระบบจะรู้ตำแหน่งพิกัดของใบหน้าคนนั้นเพื่อนำไปสร้าง Lip-sync</li>
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
