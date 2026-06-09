import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import JSZip from 'jszip';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

async function analyzeImageWithVision(imageBuffer: Buffer, mimeType: string): Promise<{ angle: string; description: string }> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.NEXT_PUBLIC_OPENAI_API_KEY || '';
  if (!apiKey) {
    console.warn('[Vision Log] Missing OPENAI_API_KEY. Using fallback.');
    return { angle: 'front view', description: 'person face portrait' };
  }

  const base64Image = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64Image}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: "Analyze this portrait image. You must classify the head pose angle and describe the visual appearance. Respond with a JSON object containing exactly two keys: 'angle' (must be one of: 'front view', 'three-quarter view', or 'side view') and 'description' (a short 1-sentence description of the person's expression, clothing, hair, and background, e.g. 'smiling expression, brown hair, wearing a white shirt, plain grey indoor background'). Do not add any backticks, markdown, or other text outside the JSON."
              },
              {
                type: 'image_url',
                image_url: {
                  url: dataUrl
                }
              }
            ]
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 150
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn('[Vision API Error]', errText);
      return { angle: 'front view', description: 'person face portrait' };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (content) {
      const parsed = JSON.parse(content);
      return {
        angle: parsed.angle || 'front view',
        description: parsed.description || 'person face portrait'
      };
    }
  } catch (err) {
    console.error('[Vision Exception]', err);
  }

  return { angle: 'front view', description: 'person face portrait' };
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const characterId = formData.get('character_id') as string;
    const userEmail = formData.get('user_email') as string;
    const triggerWordRaw = formData.get('trigger_word') as string || '';
    const steps = parseInt(formData.get('steps') as string || '1000', 10);
    const imageFiles = formData.getAll('images') as File[];
    const angles = formData.getAll('angles') as string[];

    if (!characterId || !userEmail) {
      return NextResponse.json(
        { success: false, error: 'ข้อมูลไม่ครบถ้วน กรุณาระบุรหัสตัวละครและอีเมลผู้ใช้งาน' },
        { status: 400 }
      );
    }

    if (!triggerWordRaw) {
      return NextResponse.json(
        { success: false, error: 'กรุณากรอก Trigger Word สำหรับการฝึกสอนตัวละคร' },
        { status: 400 }
      );
    }

    // Clean trigger word: alphanumeric only, no spaces
    const triggerWord = triggerWordRaw.replace(/[^a-zA-Z0-9]/g, '');
    if (!triggerWord) {
      return NextResponse.json(
        { success: false, error: 'Trigger Word ต้องประกอบด้วยตัวอักษรภาษาอังกฤษและตัวเลขเท่านั้น' },
        { status: 400 }
      );
    }

    if (!imageFiles || imageFiles.length < 6) {
      return NextResponse.json(
        { success: false, error: 'กรุณาอัปโหลดรูปภาพตัวละครเพื่อฝึกสอนอย่างน้อย 6 รูป' },
        { status: 400 }
      );
    }

    if (imageFiles.length > 20) {
      return NextResponse.json(
        { success: false, error: 'ระบบจำกัดการอัปโหลดรูปภาพชุดตัวอย่างได้ไม่เกิน 20 รูป' },
        { status: 400 }
      );
    }

    console.log(`[LoRA Train] Starting ZIP compression for ${imageFiles.length} images...`);

    // Concurrently analyze images using Vision API
    const analysisResults = await Promise.all(
      imageFiles.map(async (file, idx) => {
        const buffer = Buffer.from(await file.arrayBuffer());
        const mime = file.type || 'image/png';
        
        // Check if user specified a manual angle
        const userAngle = angles[idx]; // 'front', '45', 'side', 'auto'
        let analysis;
        if (userAngle && userAngle !== 'auto') {
          // We still want the AI description for details, but we can override the angle
          const visionResult = await analyzeImageWithVision(buffer, mime);
          let mappedAngle = 'front view';
          if (userAngle === 'front') mappedAngle = 'front view';
          else if (userAngle === '45') mappedAngle = 'three-quarter view';
          else if (userAngle === 'side') mappedAngle = 'side view';
          
          analysis = {
            angle: mappedAngle,
            description: visionResult.description
          };
        } else {
          analysis = await analyzeImageWithVision(buffer, mime);
        }
        return { file, buffer, analysis };
      })
    );

    // 1. Create ZIP in memory
    const zip = new JSZip();
    for (let i = 0; i < analysisResults.length; i++) {
      const { file, buffer, analysis } = analysisResults[i];
      const ext = file.name.split('.').pop() || 'png';
      const baseName = `image_${i + 1}`;
      
      // Save image file
      zip.file(`${baseName}.${ext}`, buffer);
      
      // Save caption file (.txt)
      const caption = `a photo of ${triggerWord}, ${analysis.angle}, ${analysis.description}`;
      zip.file(`${baseName}.txt`, caption);
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    console.log('[LoRA Train] ZIP file compressed successfully with auto-captions, size:', zipBuffer.length);

    // 2. Upload ZIP to Supabase Storage
    const timestamp = Date.now();
    const zipPath = `datasets/${userEmail}/${timestamp}_dataset.zip`;
    
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Auto-Populate missing reference images if any are empty
    try {
      const { data: charData } = await supabase
        .from('characters')
        .select('avatar_front_url, avatar_45_url, avatar_side_url')
        .eq('id', characterId)
        .single();

      if (charData) {
        const updatePayload: Record<string, any> = {};

        // Find candidates
        const frontCandidate = analysisResults.find(r => r.analysis.angle === 'front view');
        const angle45Candidate = analysisResults.find(r => r.analysis.angle === 'three-quarter view');
        const sideCandidate = analysisResults.find(r => r.analysis.angle === 'side view');

        if (frontCandidate && !charData.avatar_front_url) {
          const ext = frontCandidate.file.name.split('.').pop() || 'png';
          const path = `characters/${userEmail}/${timestamp}_auto_front.${ext}`;
          const { error: uploadErr } = await supabase.storage
            .from('kruth-ai-assets')
            .upload(path, frontCandidate.buffer, {
              contentType: frontCandidate.file.type || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
              upsert: true
            });
          if (!uploadErr) {
            const { data: { publicUrl } } = supabase.storage.from('kruth-ai-assets').getPublicUrl(path);
            updatePayload.avatar_front_url = publicUrl;
            updatePayload.avatar_front_path = path;
            console.log('[Auto-Populate] Front view populated:', publicUrl);
          }
        }

        if (angle45Candidate && !charData.avatar_45_url) {
          const ext = angle45Candidate.file.name.split('.').pop() || 'png';
          const path = `characters/${userEmail}/${timestamp}_auto_45.${ext}`;
          const { error: uploadErr } = await supabase.storage
            .from('kruth-ai-assets')
            .upload(path, angle45Candidate.buffer, {
              contentType: angle45Candidate.file.type || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
              upsert: true
            });
          if (!uploadErr) {
            const { data: { publicUrl } } = supabase.storage.from('kruth-ai-assets').getPublicUrl(path);
            updatePayload.avatar_45_url = publicUrl;
            updatePayload.avatar_45_path = path;
            console.log('[Auto-Populate] 45 degree view populated:', publicUrl);
          }
        }

        if (sideCandidate && !charData.avatar_side_url) {
          const ext = sideCandidate.file.name.split('.').pop() || 'png';
          const path = `characters/${userEmail}/${timestamp}_auto_side.${ext}`;
          const { error: uploadErr } = await supabase.storage
            .from('kruth-ai-assets')
            .upload(path, sideCandidate.buffer, {
              contentType: sideCandidate.file.type || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
              upsert: true
            });
          if (!uploadErr) {
            const { data: { publicUrl } } = supabase.storage.from('kruth-ai-assets').getPublicUrl(path);
            updatePayload.avatar_side_url = publicUrl;
            updatePayload.avatar_side_path = path;
            console.log('[Auto-Populate] Side view populated:', publicUrl);
          }
        }

        if (Object.keys(updatePayload).length > 0) {
          await supabase
            .from('characters')
            .update(updatePayload)
            .eq('id', characterId);
          console.log('[Auto-Populate] Character reference images updated in database.');
        }
      }
    } catch (dbErr) {
      console.warn('[Auto-Populate Exception] Failed to check/populate character images:', dbErr);
    }

    console.log(`[LoRA Train] Uploading ZIP dataset to Supabase Storage: ${zipPath}`);
    const { error: uploadError } = await supabase.storage
      .from('kruth-ai-assets')
      .upload(zipPath, zipBuffer, {
        contentType: 'application/zip',
        upsert: true,
      });

    if (uploadError) {
      console.error('[LoRA Train] Supabase ZIP upload failed:', uploadError);
      return NextResponse.json(
        { success: false, error: 'อัปโหลดชุดรูปภาพไปยัง Cloud Storage ไม่สำเร็จ' },
        { status: 500 }
      );
    }

    const { data: { publicUrl: zipUrl } } = supabase.storage
      .from('kruth-ai-assets')
      .getPublicUrl(zipPath);

    console.log('[LoRA Train] ZIP dataset URL generated:', zipUrl);

    // 3. Submit LoRA training job to Fal.ai
    const falKey = process.env.FAL_KEY || process.env.NEXT_PUBLIC_FAL_KEY;
    if (!falKey) {
      return NextResponse.json(
        { success: false, error: 'ระบบปิดการตั้งค่าเทรนชั่วคราวเนื่องจากไม่พบ FAL_KEY' },
        { status: 500 }
      );
    }

    const requestPayload = {
      images_data_url: zipUrl,
      trigger_word: triggerWord,
      steps: steps,
      is_style: false,
    };

    console.log('[LoRA Train] Submitting training job to Fal.ai queue...');
    const falResponse = await fetch('https://queue.fal.run/fal-ai/flux-lora-fast-training', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${falKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });

    if (!falResponse.ok) {
      const errText = await falResponse.text();
      console.error('[LoRA Train] Fal.ai queue submission failed:', errText);
      return NextResponse.json(
        { success: false, error: 'ส่งคำขอเริ่มการเทรนไปยังระบบ AI ไม่สำเร็จ' },
        { status: 500 }
      );
    }

    const result = await falResponse.json();
    const requestId = result.request_id;
    console.log(`[LoRA Train] Job submitted successfully. Job ID: ${requestId}`);

    if (!requestId) {
      return NextResponse.json(
        { success: false, error: 'ระบบ AI ปลายทางไม่ได้ส่งคืนรหัสงานประมวลผล' },
        { status: 500 }
      );
    }

    // 4. Update Character status in Supabase DB
    const { error: dbError } = await supabase
      .from('characters')
      .update({
        lora_status: 'training',
        lora_job_id: requestId,
        lora_trigger_word: triggerWord,
        lora_dataset_url: zipUrl,
        lora_dataset_path: zipPath,
        lora_steps: steps,
        updated_at: new Date().toISOString(),
      })
      .eq('id', characterId);

    if (dbError) {
      console.error('[LoRA Train] Database update failed:', dbError);
      return NextResponse.json(
        { success: false, error: 'บันทึกสถานะโมเดลลงฐานข้อมูลล้มเหลว' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'เริ่มการเทรนเรียบร้อยแล้ว ระบบจะใช้เวลาประมวลผลประมาณ 5-10 นาที',
      jobId: requestId,
    });
  } catch (error: any) {
    console.error('[LoRA Train Error]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'เกิดข้อผิดพลาดในการเริ่มเทรนโมเดล' },
      { status: 500 }
    );
  }
}
