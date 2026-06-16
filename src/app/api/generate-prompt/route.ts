import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60s timeout

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const prompt = formData.get('prompt') as string || '';
    const type = formData.get('type') as string || 'image'; // 'image' | 'video' | 'ambient'
    const imageFile = formData.get('image') as File | null;

    const geminiKey = process.env.GOOGLE_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY || process.env.NEXT_PUBLIC_OPENAI_API_KEY;

    if (!geminiKey && !openaiKey) {
      return NextResponse.json({ success: false, error: 'ระบบไม่พบคีย์ Google API Key หรือ OpenAI API Key' }, { status: 500 });
    }

    // System instruction and user message templates
    let systemPrompt = '';
    if (type === 'image') {
      systemPrompt = `You are a professional AI Prompt Engineer for text-to-image models like Flux and Stable Diffusion.
Your task is to take the user description (which might be in Thai or English) and expand it into a highly detailed, cinematic English image generation prompt (max 100 words).
Ensure you translate Thai text to English. Describe lighting, environment, camera details, and styling.
Keep it concise, descriptive, and return ONLY the enhanced English prompt without any prefix, quotes, explanations, or markdown.`;
    } else if (type === 'video') {
      systemPrompt = `You are a professional AI Prompt Engineer for text-to-video models like Kling and Luma.
Your task is to take the user motion instruction (which might be in Thai or English) and expand it into a detailed, professional English video motion prompt (max 80 words).
Describe camera movements (e.g., panning, zooming, sliding), character actions, natural dynamics (e.g. hair blowing, wind blowing), and lighting changes.
Keep it concise, and return ONLY the enhanced English prompt without any prefix, quotes, explanations, or markdown.`;
    } else if (type === 'ambient') {
      systemPrompt = `You are a professional Sound Designer and Sound Effects prompt engineer.
Your task is to analyze the user description and/or the context of the uploaded image to generate a detailed, effective English text prompt for generating background ambient sound effects (max 50 words).
Describe the background noise, ambient sounds, chatter, and environment (e.g. "low hum of crowded pub conversation, clinking beer glasses, soft background acoustic music").
Keep it focused on audio details, and return ONLY the generated English sound prompt without any prefix, quotes, explanations, or markdown.`;
    }

    let generatedText = '';
    let success = false;

    // 1. Try Gemini first if key exists
    if (geminiKey) {
      try {
        console.log(`[Generate Prompt API] Trying Gemini for type: ${type}...`);
        
        // Prepare content parts for Gemini
        const parts: any[] = [];
        parts.push({
          text: `${systemPrompt}\n\nUser input: "${prompt}"`
        });

        // Handle multimodal image if uploaded
        if (imageFile && imageFile.size > 0) {
          const arrayBuffer = await imageFile.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString('base64');
          parts.push({
            inlineData: {
              mimeType: imageFile.type || 'image/png',
              data: base64
            }
          });
          parts[0].text += `\n\nAnalyze the attached image context and use it to enhance the prompt appropriately.`;
        }

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [{
              parts: parts
            }]
          })
        });

        if (response.ok) {
          const resJson = await response.json();
          generatedText = resJson.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
          if (generatedText) {
            success = true;
            console.log('[Generate Prompt API] Gemini successfully generated prompt.');
          }
        } else {
          const errText = await response.text();
          console.error('[Generate Prompt API] Gemini API error response:', errText);
        }
      } catch (geminiErr) {
        console.error('[Generate Prompt API] Gemini API exception:', geminiErr);
      }
    }

    // 2. Fallback to OpenAI if Gemini failed or was skipped
    if (!success && openaiKey) {
      try {
        console.log(`[Generate Prompt API] Gemini failed or skipped. Falling back to OpenAI (gpt-4o-mini)...`);
        
        const messages: any[] = [];
        messages.push({
          role: 'system',
          content: systemPrompt
        });

        const userContent: any[] = [
          { type: 'text', text: `User input: "${prompt}"` }
        ];

        // Handle multimodal image if uploaded
        if (imageFile && imageFile.size > 0) {
          const arrayBuffer = await imageFile.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString('base64');
          userContent.push({
            type: 'image_url',
            image_url: {
              url: `data:${imageFile.type || 'image/png'};base64,${base64}`
            }
          });
          userContent[0].text += `\n\nAnalyze the attached image context and use it to enhance the prompt appropriately.`;
        }

        messages.push({
          role: 'user',
          content: userContent
        });

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiKey}`
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: messages,
            temperature: 0.7
          })
        });

        if (response.ok) {
          const resJson = await response.json();
          generatedText = resJson.choices?.[0]?.message?.content?.trim() || '';
          if (generatedText) {
            success = true;
            console.log('[Generate Prompt API] OpenAI successfully generated prompt.');
          }
        } else {
          const errText = await response.text();
          console.error('[Generate Prompt API] OpenAI API error response:', errText);
        }
      } catch (openaiErr) {
        console.error('[Generate Prompt API] OpenAI API exception:', openaiErr);
      }
    }

    if (!success || !generatedText) {
      return NextResponse.json({ success: false, error: 'เรียกใช้บริการ AI (Gemini/OpenAI) ไม่สำเร็จ' }, { status: 520 });
    }

    // Strip leading/trailing quotes if the model wrapped it
    if (generatedText.startsWith('"') && generatedText.endsWith('"')) {
      generatedText = generatedText.slice(1, -1);
    }
    if (generatedText.startsWith("'") && generatedText.endsWith("'")) {
      generatedText = generatedText.slice(1, -1);
    }

    console.log(`[Generate Prompt API] Successfully generated prompt: ${generatedText}`);
    return NextResponse.json({ success: true, prompt: generatedText });

  } catch (err: any) {
    console.error('[Generate Prompt API Exception]', err);
    return NextResponse.json({ success: false, error: err.message || 'เกิดข้อผิดพลาดในการประมวลผล' }, { status: 500 });
  }
}
