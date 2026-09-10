<!-- กู้คืน 10 ก.ย. 2569: ไฟล์นี้หายไปจาก Downloads ระหว่างวัน จึงประกอบใหม่จาก transcript ของ Claude (ฉบับเขียนเต็ม 3 ก.ย. + ทุกครั้งที่อ่าน/แก้หลังจากนั้น) — ช่วงที่มีสำเนาตรวจสอบตรงกัน 100%: บรรทัด 1–169 (สถานะ 5 ก.ย.) และ 205–369 (สถานะ 7–9 ก.ย.); บรรทัด ~170–204 ไม่มีสำเนาอ่านหลัง 3 ก.ย. จึงอาจต่างจากที่คุณแก้เองเล็กน้อย · สำเนาถาวรอยู่ใน repo ที่ docs/SPEC-vfx-studio-mode.md -->
# SPEC: เพิ่มโหมด "VFX Studio" ในแพลตฟอร์มสร้างคลิป/รูปภาพเดิม

> วางใน Claude Code ทีละขั้น (Prereq → ขั้น 0 → 1 → 2) อย่าข้ามขั้น
>
> **ฉบับปรับปรุง 3 ก.ย. 2569** — ผนวกผล audit ระบบ kruth-ai-video จริง + ตรวจตลาดโมเดลสดจาก Fal
> **ทิศทางใหม่ (4 ก.ย.): ระบบเปลี่ยนเป้าหมายจากสื่อครูเป็นโปรดักชันหนัง** — tier ultra เป็นของหลัก ไม่ใช่ตัวเลือกเสริม
> **สถานะ 5 ก.ย. 2569:** Prereq A ✅ · Prereq B ✅ · รอบพิสูจน์โมเดลท็อป ✅ · Dialogue **Scene Beat** ✅ (ส่วน "ผลทดลอง (ข)") · **VFX Phase 0.5 ✅ · ควิกวิน color-match ✅ · Phase 1 ✅ · Phase 2 ✅ · Phase 3 ✅ (6 ก.ย.)** (ส่วน "ขั้น 2") · โมเดลภาพ ultra 6 ตัวเข้า Image Gen ✅ — ค้าง: รัน `scripts/sql/vfx_phase1.sql` (ระบบสลับเข้าตารางเอง) · ถัดไป: Phase 4 (router เลือก provider จากบิล, batch, เทมเพลต) หรือ Film Mode F1
> ต้นฉบับเดิมอยู่ที่ `SPEC-vfx-studio-mode.orig.md`

---

## กฎเหล็กของโปรเจกต์นี้ (บังคับทุก Phase — จ่ายค่าเรียนมาแล้วด้วยเงินจริง)

1. **คิวรับงาน ≠ โมเดลมีจริง** — คิว Fal รับทุก path แล้วค่อยตาย 404 ตอนดึงผล ทุก endpoint ต้องพิสูจน์ด้วย submit → poll → **ได้ไฟล์จริง** ก่อนเขียนเข้าตาราง provider
2. **ราคาป้าย ≠ ราคาบิล** — ตั้งเครดิตจาก CSV usage export ของ Fal เท่านั้น (บทเรียน: lip-sync เคยกิน 59% ของบิลทั้งเดือนโดยไม่ถูกคิดเครดิตเลย)
3. **ffmpeg บน Vercel เป็น static build ปี 2018** — ฟิลเตอร์/ออปชันใหม่พังเงียบเฉพาะบน production; ออปชันใหม่ทุกตัวต้องทดสอบผ่าน diag endpoint ชั่วคราวก่อนใช้ (แพทเทิร์นใน git: `dd58e1e`)
4. **เพดาน 300 วิ/คำขอ + ~4.5MB/request body** — งานยาวต้องแบ่งช่วง (แพทเทิร์น merge-dialogue: กลุ่มละ 8) และไฟล์ผู้ใช้อัปโหลดตรงเข้า storage ผ่าน signed URL เสมอ ห้ามส่งผ่านฟังก์ชัน

---

## Prereq (ทำก่อนขั้น 0 — ปลดล็อกทุกอย่างข้างล่าง)

### Prereq A — ตัวเดินงานฝั่งเซิร์ฟเวอร์ (ช่องว่างใหญ่สุดที่ audit พบ) — **✅ เสร็จ 3 ก.ย. 2569**
> ส่งมอบ: `/api/cron/drive` กวาดงาน processing ค้าง แล้วเรียกตรรกะเฟสเดิม (`video-status`) แทนเบราว์เซอร์ · ตัวตั้งเวลาจริง = GitHub Actions ทุก 5 นาที (`.github/workflows/drive-jobs.yml`) เพราะ Vercel Hobby ห้าม cron ถี่กว่ารายวัน (สเปคเดิมทึกทักว่าใช้ Vercel Cron ได้ — deploy ล้มทั้งชุดเมื่อตั้งรายนาที) · Vercel cron รายวันเป็นชั้นสำรองสุดท้าย
> **Acceptance ผ่านแล้ว:** ส่งงานภาพแล้วไม่ poll เลย (จำลองปิดแท็บ) → ตัวเดินงานเก็บจบเป็น completed พร้อมไฟล์ในคลัง
> บทเรียนเพิ่ม: เรียกกลับตัวเองต้องใช้โดเมน production สาธารณะ ไม่ใช่ `VERCEL_URL` (ติด deployment protection → 401)
ระบบปัจจุบัน**ไม่มี** job queue/worker — ทุกเฟส (lip-sync → ambient → face-restore) เดินด้วยการ poll จากเบราว์เซอร์ของผู้กดสร้าง สลับหน้า/ปิดแท็บเมื่อไหร่งานแขวน (เกิดจริงกับงาน Motion Control เมื่อ 3 ก.ย.) ท่อ VFX ที่ต้องวิ่ง 5–7 งานต่อเนื่องต่อช็อตอยู่บนกลไกนี้ไม่ได้

- ตาราง `jobs` ทั่วไป (id, kind, payload JSON, status, attempt, error, next_poll_at) — สร้างเมื่อเริ่ม VFX Phase 0.5 (ตอนนี้ตัวเดินงานใช้ `generations` เป็น job record เดิมไปก่อน) · ตัวตั้งเวลา = GitHub Actions ทุก 5 นาที (ไม่ใช่ Vercel Cron — Hobby plan ห้ามถี่กว่ารายวัน)
- `vfx_jobs` ของสเปคนี้ = ตารางงานจริง**ตัวแรกของทั้งแพลตฟอร์ม** — โหมดเดิมทยอยย้ายเข้ามาทีหลัง
- **Acceptance:** กดสร้างแล้วปิดแท็บทันที → งานเดินจนจบเองและขึ้นในคลัง

### Prereq B — ModelRouter (refactor ล้วน พฤติกรรมเดิมไม่เปลี่ยน) — **✅ เสร็จ 3 ก.ย. 2569**
> ส่งมอบ: `src/lib/providers/fal.ts` (ประตูเดียวสู่ Fal: baseAppId / falSubmit+เหตุผลปฏิเสธ / falStatus / falResult / normalizeOutput) + `src/lib/providers/registry.ts` (แคตตาล็อกโมเดล: endpoint ล็อกเวอร์ชัน, ราคา+ที่มา bill/measured/list, เครดิต, **tier economy/pro/ultra**, **verified** — โมเดลที่ยังไม่พิสูจน์ปลายทางเปิดใช้ไม่ได้) · สามเส้นทางหลัก (generate-video / generate-image / video-status) เรียกผ่าน adapter หมดแล้ว
> **ทดสอบถดถอยผ่านบน production:** ภาพ (submit→status→result) และวิดีโอโหมด B ครบทุกเฟส (ฐาน → lip-sync → ambient → ผสม → เก็บ) ผ่าน adapter ทั้งสาย พฤติกรรมเดิมไม่เปลี่ยน
> ทิศทางใหม่ (3 ก.ย.): ระบบย้ายจากสื่อครูสู่**งานโปรดักชันจริง** และ**เพิ่มโมเดลตัวท็อป** — registry รองรับแล้วด้วย tier + pinning
ย้ายการเรียก Fal ที่ฝังตรงใน route ทั้งหมดเข้า `src/lib/providers/` — adapter ต่อ task มี `estimateCost()`, `run()`, `normalizeOutput()` (คืน asset + metadata รูปเดียวกันทุก provider) — ทดสอบด้วยชุด test เดิมของโหมดเดิมทั้งหมด

### ควิกวินระหว่างทาง (แนะนำทำทันที ~ครึ่งวัน) — **✅ เสร็จ 5 ก.ย. 2569** (commit `f108c8b`)
ยก **anchor-frame color match** ของ Film Mode มาใส่ `merge-dialogue` เลย (ffmpeg ล้วน ไม่มี generative job) — แก้ปัญหาสีเพี้ยนข้ามช็อตที่ผู้ใช้เจออยู่จริง และเป็นการซ้อม color pipeline ของ Film Mode ด้วยงานจริง
> ส่งมอบ: flag `colorMatch` ใน merge — คลิปแรกของชุดเป็น anchor วัดค่าเฉลี่ย RGB (1 พิกเซล/เฟรมที่สุ่ม) แล้วดันคลิปถัดไปเข้าหาด้วย `colorchannelmixer` gain ต่อช่อง (60% ของค่าที่วัด, clamp ±15%) · เปิดเฉพาะการรวม**ภายในฉาก** (ต่างฉากปล่อยให้ต่างกัน) · สวิตช์ "เกลี่ยสีข้ามช็อต" ในตั้งค่า Dialogue เปิดเป็นค่าเริ่มต้น เก็บในดราฟต์ · VFX export ใช้ด้วย
> ทดสอบ production: คลิปอุ่น (mean 133/107/80) + คลิปเย็น (53/44/40) → เปิด match คลิปสองขยับเป็น 59/49/40 (ทิศถูก แรงพอดี ไม่ทาสีทับ)

---

## ขั้น 0 — Audit ก่อน (ห้ามเขียนโค้ด)

> **สถานะ: ทำแล้ว 3 ก.ย. 2569** — ผลสรุป:

| สิ่งที่สเปคคาดว่ามี | สภาพจริง | ผล |
|---|---|---|
| Job queue / worker / retry | ไม่มี — client-driven polling ล้วน | ❌ → Prereq A |
| Model adapter layer | ครึ่งทาง (`EDIT_MODELS` map, `baseAppId()`) แต่ route เรียก Fal ตรง | ⚠️ → Prereq B |
| ตาราง project/job/asset | `generations`+metadata ≈ job ดั้งเดิม · scene ของ Dialogue ≈ โครง shot · `characters` ≈ master_assets ยุคแรก (มี consent-แชร์/ระงับแล้ว) | ✅ ต่อยอด |
| Storage + signed URL | ครบ ผ่านศึกแล้ว | ✅ |
| ffmpeg composite | มีและใช้หนักแล้ว (merge/mux/mix/LUT) ภายใต้กฎเหล็กข้อ 3–4 | ✅ มีเงื่อนไข |
| UI generate + เครดิต | ครบ เครดิตสอบเทียบกับบิลจริงแล้ว | ✅ |

**ข้อสรุปที่อนุมัติแล้ว:** ไม่แยก `/modules/vfx` และไม่ "ขยาย job เดิม" (เพราะไม่มีตัวตนจริง) — `vfx_jobs` เป็นตารางงานกลางตัวแรก, adapters ที่ `src/lib/providers/`, UI เป็นแท็บใหม่บนหน้า dashboard เดิม

---

## ขั้น 1 — เป้าหมายและ Data Model

### เป้าหมาย
ผู้ใช้อัปโหลด **ฟุตเทจคนแสดงจริง** + **ภาพอ้างอิง/สไลด์** ของฉากที่ต้องการ → ระบบตัดตัวคนออก, สร้างฉากหลังใหม่, ซ้อนเอฟเฟกต์ (ควัน/ไฟ), เปลี่ยนหน้า-ชุดตัวละคร (ถ้าเลือก), ปรับแสงและเกลี่ยสี → ได้คลิปสุดท้าย โดยผู้ใช้ **อนุมัติทีละ shot ทีละเลเยอร์** และแก้เฉพาะเลเยอร์ที่ไม่พอใจได้โดยไม่ต้อง gen ใหม่ทั้งหมด

### ตาราง (ต่อยอดจากของเดิม ไม่สร้างซ้ำถ้ามีอยู่แล้ว)
- `vfx_projects` — id, user_id, name, source_footage_asset_id, reference_asset_ids[], global_style (JSON: LUT/mood/palette), status
- `vfx_shots` — id, project_id, order, start_frame, end_frame, edit_plan (JSON), status (draft|processing|review|approved)
- `vfx_layers` — id, shot_id, type (`matte`|`background`|`fx`|`character`|`relight`|`grade`|`composite`), params (JSON), model_used, cost_credits, output_asset_id, version, status
- `vfx_jobs` — **ตารางงานกลางจาก Prereq A**: layer_id, step, attempt, error, next_poll_at

หลักการ: **1 layer = 1 job = 1 artifact** เวอร์ชันเก่าเก็บไว้ rollback ได้

---

## ขั้น 1 — Pipeline และ Model Adapter

ทุกขั้นเรียกผ่าน `ModelRouter.run(task, input, options)` — ห้ามผูก API ตรงใน pipeline

> **ตาราง provider ปรับตามที่มีจริงบน Fal (ตรวจสด 3 ก.ย. 2569)** — ทุกตัวยังต้องผ่านกฎเหล็กข้อ 1–2 ก่อนใช้จริง

| step | task | provider เริ่มต้น (ราคาป้าย) | fallback |
|---|---|---|---|
| matte | ตัดตัวคน + alpha ทุกเฟรม | `veed/video-background-removal/fast` ($0.012/30fr) | `bria/video/background-removal/v3` ($0.05/s) · `fal-ai/sam2/video` |
| background | สร้างฉากจาก reference + prompt, กล้องตามฟุตเทจ | `fal-ai/kling-video/o3/pro/video-to-video/edit` ($0.168/s) | `fal-ai/wan/v2.7/edit-video` ($0.10–0.15/s) |
| fx | ควัน/ไฟ/ประกาย พร้อม alpha | **คลัง stock FX (webm alpha) — สลับขึ้นเป็นตัวหลัก: ถูกกว่า นิ่งกว่า** | image-to-video + matte (gen เมื่อจำเป็น) |
| character | เปลี่ยนหน้า/ชุด จาก element reference | `fal-ai/kling-video/o3` element edit | `alibaba/happy-horse/video-edit` (~$0.2x/s) |
| relight | ปรับแสงเงาให้เข้ากับฉาก | `fal-ai/lightx/relight` ($0.10/s) — มีจริง ไม่ต้อง skip | skip + grade |
| grade | LUT / color match ทั้งคลิป | ffmpeg + LUT ที่ LLM เลือก (ระวังกฎเหล็กข้อ 3) | — |
| composite | ประกอบทุกเลเยอร์ frame-accurate | ffmpeg filter graph แบ่งช่วงตามกฎเหล็กข้อ 4 | — |

Adapter ต้องมี: `estimateCost()`, `run()`, `normalizeOutput()` (คืน asset + metadata เดียวกันทุก provider)

### ผลรอบพิสูจน์โมเดลท็อป (4 ก.ย. 2569 — ยิงจริง + ราคาบิลจริง งบ ~$8)
| โมเดล | บิลจริง/วิ | ผล |
|---|---|---|
| Kling O3 Standard / Pro / 4K | $0.084 / $0.112 / $0.42 (ตรงป้ายทั้งหมด) | ✅ 4K = 2492×3324 คมจริง |
| Kling O3 Video Edit (background) | $0.163 | ✅ เปลี่ยนฉากเนียน คนคงเดิม — **ตัวหลัก background layer** |
| Wan 2.7 Edit | $0.20 (**สูงกว่าป้าย 720p 2 เท่า**) | ✅ ใช้ได้ ภาพออกแนววาด — fallback |
| veed matte fast | $0.0122 | ✅ RGB ดำนอกตัวคน + alpha → ใช้กับ ffmpeg เก่าได้ (luma-key) — **ตัวหลัก matte** · **5 ก.ย.: โหมด `output_codec:'h264'` คืน color.mp4 + alpha.mp4 แยกกัน → alphamerge ตรงๆ ไม่ต้อง key** (แต่ color สั้นกว่า alpha — ใช้ฟุตเทจเดิมเป็นสี) |
| Bria matte v3 | $0.05 | ✅ alpha ล้วน — ffmpeg 2018 ถอดไม่ได้ ต้องสั่ง `mov_proresks` |
| LightX relight | $0.068 | ❌ ออก 672×384 แสงฟุ้ง — ไม่เปิดใช้ (relight → ใช้ grade แทนใน Phase แรก) |
| Seedance 2.5 text-to-video | $0.207 (480p) | ✅ ภาพระดับหนัง |
| Seedance 2.5 image/reference-to-video | — | ❌ **ByteDance ปฏิเสธภาพเหมือนคนจริง** (partner_validation_failed) — ใช้กับนักแสดง AI photoreal ไม่ได้ |

> **ผลทดลอง (ข) Dialogue beat สองตัวละคร (5 ก.ย., $1.22): ✅ ทำได้** — Kling O3 Standard reference-to-video (@Image1/@Image2 + prompt กำกับสลับพูด, 12 วิ $1.01) → Kling lip-sync ด้วยแทร็กสองเสียงต่อกัน ($0.21) → ปากขยับ**ถูกคนตามลำดับเสียง** (ตรวจแถบเฟรม: ชายพูดช่วงเสียงชาย หญิงหุบปากหันมอง; ชายนิ่งช่วงเสียงหญิง) · ≈ $0.10/วิ ≈ 2 เท่าของแบบต่อการ์ด แต่ได้ two-shot ต่อเนื่องพร้อมปฏิกิริยา · O3 ไม่รับเสียงเข้า มี `multi_prompt` แบ่งช็อตเป็นแผนสำรอง → **โหมด "Scene Beat" ของ Dialogue Engine สร้างบนเครื่องยนต์ชุดนี้**
> **✅ สร้างแล้ว 5 ก.ย. 2569 — โหมด "Scene Beat" ใน Dialogue Engine** (commit `76e4b7b`): สวิตช์ต่อฉาก "ทีละบท / Scene Beat" · ตัวจัดกลุ่มรวมบทติดกัน ≤12 วิ (ประมาณ 15 ตัวอักษร/วิ + เว้น 2 วิ) ≤8 บรรทัด ≤3 ตัวละคร · `/api/generate-beat` พูดทุกบรรทัด → ต่อเสียง → **วัดความยาวจริง** (เกิน 15 วิ → ปฏิเสธพร้อมวินาทีต่อบรรทัด แล้ว client แบ่งครึ่งตามเวลาจริง) → prompt กำกับสลับพูด (@Image1/@Image2 ใครพูด ใครฟังปากปิด) → O3 Standard reference-to-video → แถว `generations` รูปเดิม ให้ `video-status` ทำ lip-sync + เลื่อนเสียง 0.25 วิ + เก็บไฟล์เอง · merge ฉากใช้ 1 คลิปต่อบีต (เต็มเฟรม ไม่คอมโพสิต) · ราคา 12 เครดิต/วิ (O3 10 + lip-sync 2)
> **E2E บน production ผ่าน (5 ก.ย.):** 2 บรรทัด 2 ตัวละคร (Kore/Charon) วัดได้ 6.45+6.01 วิ → duration 13 → 157 เครดิต → O3 240 วิ → lip-sync → ไฟล์ 12.97 วิ 1280×720 มีแทร็กเสียง · เฟรม 3 วิ: หญิงพูด ชายฟัง · เฟรม 10 วิ: ชายพูด หญิงหุบปากหันมอง · ฉากแล็บตาม situation prompt ทั้งคู่อยู่ในเฟรมตลอด
> ข้อจำกัดที่รู้: บีตใช้เสียง TTS เท่านั้น (การ์ดที่อัปโหลดเสียงเองยังไม่เข้าบีต) · ใช้รูปตัวละครเป็นภาพอ้างอิง ไม่ใช้แท็กใบหน้าบนภาพฉาก · ภาพฉากถูกส่งเป็นภาพอ้างอิงที่ 3 เมื่อตัวละคร ≤2
> บทเรียนใหม่เข้ากฎเหล็กข้อ 1: false positive อีกรูปแบบ = คิวตอบ COMPLETED ในไม่กี่วินาที แต่ผลลัพธ์เป็น HTTP 422 พร้อม url ไปหน้า docs — ต้องเช็ค HTTP 2xx ของผลลัพธ์เสมอ ห้ามหยิบ url ใดๆ จาก JSON มาใช้

### เศรษฐศาสตร์ (เพิ่มใหม่ — ต้องตัดสินใจก่อน Phase 1)
ช็อต 10 วิ 1080p ครบเลเยอร์ ≈ **$3–4/ช็อต** → คลิป 2 นาที ≈ **$40+/เวอร์ชัน** — คนละระดับกับคลิปครู 5 วิ ($0.2–0.5) → VFX Studio ต้องเป็น **tier แยก ราคาแยก** จากเครดิตครูปัจจุบัน และหน้ายืนยัน `estimated_credits` ก่อนหักเป็นข้อบังคับจริง ไม่ใช่พิธีกรรม

---

## ขั้น 1 — Orchestrator (LLM)

Input: คำสั่งผู้ใช้ + reference images + ข้อมูลฟุตเทจ (duration, fps, จำนวนคน, การเคลื่อนกล้อง จาก VLM pre-analysis — ใช้ Gemini คีย์ `GEMINI_API_KEY` ที่มีแล้ว)
Output: **JSON edit plan เท่านั้น** ตาม schema:

```json
{
  "shots": [{
    "start": 0, "end": 120,
    "layers": [
      {"type": "background", "prompt": "...", "reference": "ref_1", "camera": "match_source"},
      {"type": "fx", "kind": "smoke", "region": "lower_left", "intensity": 0.6},
      {"type": "grade", "lut": "teal_orange", "match_to": "ref_1"}
    ],
    "skip": ["character"]
  }],
  "estimated_credits": 0,
  "warnings": []
}
```

- ต้องเสนอ `estimated_credits` และผู้ใช้ **ยืนยันก่อนหักเครดิต**
- ห้าม LLM เรียกโมเดลเอง — orchestrator วางแผน, worker (Prereq A) ทำงาน

---

## ขั้น 1 — UI (ต่อยอดหน้า generate เดิม)

1. Upload footage + reference slides (อัปโหลดตรงเข้า storage — กฎเหล็กข้อ 4) → ระบบ pre-analyze แล้วแบ่ง shot อัตโนมัติ
2. หน้า Plan: แสดง shot list + เลเยอร์ที่จะทำ + เครดิต → ผู้ใช้เปิด/ปิดแต่ละเลเยอร์ → กดยืนยัน
3. หน้า Review ต่อ shot: เทียบ before/after, toggle แต่ละเลเยอร์, ปุ่ม "gen ใหม่เฉพาะเลเยอร์นี้" พร้อมช่องแก้ prompt
4. Approve ทุก shot → composite → export MP4 (+ ProRes/alpha ถ้า pro tier)

---

## Guardrails (บังคับ)

- เลเยอร์ `character`: ต้องมี consent record ของเจ้าของใบหน้าอ้างอิง (upload consent + checkbox) ก่อนรัน; ปฏิเสธถ้า reference เป็นบุคคลสาธารณะ — *ต่อยอดจากระบบ characters เดิมที่มีเจ้าของ/แชร์รายอีเมล/แอดมินระงับ-ลบอยู่แล้ว*
- Watermark: เริ่มที่ **metadata tag + ลายน้ำที่มองเห็น** ในทุก output ที่มี character edit (C2PA เต็มรูปแบบบน serverless ยังหนัก — เป็นเป้าระยะถัดไป ไม่ใช่เงื่อนไขเริ่ม)
- VLM QA ทุกเลเยอร์ก่อนเข้า review: ขอบหลุด, แสงไม่ตรง, เฟรมกระโดด → **ติดธง (ไม่บล็อก) ใน Phase แรก** กันผลบวกลวงขวางงาน

---

## ขั้น 2 — ลำดับ Build (ทำทีละ phase, รอผมอนุมัติทุก phase)

- **Phase 0.5 (ใหม่)**: MVP "เปลี่ยนฉากหลังวิดีโอ" โหมดเดียวจบ — matte + background + grade + composite ยังไม่มี UI เลเยอร์ → ได้ของให้ผู้ใช้เร็วสุด และพิสูจน์ matte→composite บนเพดาน 300 วิด้วยงานจริง
  > **✅ สร้างแล้ว 5 ก.ย. 2569** (commits `7c136ad`, +แก้ composite) — แท็บใหม่ "เปลี่ยนฉากหลัง (VFX)" บน dashboard · `/api/vfx/background` · ฟุตเทจอัปโหลดตรงเข้า storage ผ่าน signed URL (กฎเหล็กข้อ 4) · ฉากหลังจากภาพที่อัปโหลด หรือ Flux Dev สร้างจากคำบรรยายตามสัดส่วนฟุตเทจ (~3 เครดิต) · ราคาจาก registry (bill-verified) แสดงและ**ติ๊กยืนยันก่อนหัก** · แถว `generations` ให้ `video-status` + ตัวเดินงานพาไปจบเอง (ปิดแท็บได้)
  > **เครื่องยนต์ 2 ตัว:** (1) **matte** = veed fast โหมด `output_codec:'h264'` → คืน **2 คลิป color.mp4 + alpha.mp4** (ค้นพบใหม่ — ไม่ต้อง luma-key อีก) → ffmpeg `alphamerge` + `overlay` บนภาพฉากที่ scale/crop ให้พอดีเฟรม + grade (eq/colorbalance) + เสียงจากฟุตเทจเดิม · 2 เครดิต/วิ · ฟุตเทจ ≤30 วิ (2) **o3** = Kling O3 Pro video edit รับภาพฉากเป็น `@Image1` + prompt คงคน/ท่า/กล้อง · 19 เครดิต/วิ · ฟุตเทจ 3–15 วิ · grade ทั้งเฟรมหลังได้ผล
  > **E2E production (5 ก.ย.) ผ่านทั้งสอง:** ฟุตเทจครู 7.2 วิ 816×1104 → matte เสร็จใน 57 วิ (รวม Flux + veed + composite) ตัดผมสะอาด ฉากห้องสมุด grade อุ่นติด · O3 edit 7.04 วิ 1236×1672 ฉากห้องสมุดเนียน คนคงเดิม เสียงคงเดิม 153 เครดิต
  > **บทเรียนจากรอบแรก (แก้แล้ว):** ① veed คืน color.mp4 **สั้นกว่า** alpha.mp4 (6.36 vs 7.20 วิ) → composite ใช้**ฟุตเทจต้นฉบับเป็นแหล่งสี**เมื่อขนาดเฟรมตรงกับ alpha (ยาวเต็ม พิกเซลรุ่นแรก เสียงตัวเอง) ใช้ color.mp4 เฉพาะเป็น fallback ② ห้ามเชื่อขนาดเฟรมจาก client — composite วัดขนาดจากคลิปเองด้วย ffmpeg (ทดสอบรอบแรกส่ง 1280×720 ให้ฟุตเทจแนวตั้ง → คนถูกครอป) ③ `alphamerge` ใน ffmpeg 4.1 ไม่มีออปชัน `shortest` ④ ภาพนิ่งที่ `-loop 1` ตั้งนาฬิกากราฟเป็น 25 fps → ฟุตเทจ 30 fps ถูก resample (7.20→7.12 วิ) — ต้องส่ง `-framerate <fps ของคลิป>` และ `-r` ⑤ `-shortest` บน ffmpeg 4.1 ตัดท้ายคลิป (7.20→6.97 วิ) ทั้งที่ 4.4 ในเครื่องไม่ตัด — เอาออก ใช้ `overlay=shortest=1` คุมความยาวแทน (ตัวอย่างชัดของกฎเหล็กข้อ 3)
  > ยังไม่ทำใน 0.5: ตาราง `vfx_jobs`/layers (ยังใช้ `generations`+metadata) · regen เฉพาะเลเยอร์ · VLM QA · color-match อัตโนมัติกับฉาก (grade เป็น preset 4 แบบ)
- **Phase 1**: vfx_projects/shots/layers + UI ข้อ 1–4 เต็มรูป (ไม่มี fx/character)
  > **✅ สร้างแล้ว 5 ก.ย. 2569** (commit `481b086`) — แท็บ VFX มี 2 โหมดย่อย: **สตูดิโอ** (ค่าเริ่มต้น) และ โหมดด่วน (Phase 0.5)
  > **อัปเดต 5 ก.ย. (ค่ำ):** `store.ts` ตรวจหาตาราง `vfx_projects` เองครั้งเดียวต่อโปรเซส — รัน `scripts/sql/vfx_phase1.sql` (ตารางคอลัมน์ `doc jsonb` + สรุป + view `vfx_shots_v`/`vfx_layers_v`) ใน Supabase SQL editor แล้วระบบเริ่มเขียน/อ่านผ่านตารางทันที ไม่ต้อง deploy ใหม่ ไฟล์ใน storage ยังเป็นสำเนา write-through · Scene Beat รับไฟล์เสียงที่อัปโหลดต่อบท (`audio_url`) แทน TTS แล้ว · enhancer 4 เส้นทางเดิมย้ายไป `src/lib/gemini.ts` (`gemini-3.6-flash`, ใช้ `GEMINI_API_KEY` ก่อน) — ปิดช่องที่ถอยไป OpenAI เงียบ
  > **Data model:** เอกสารโปรเจกต์ 1 ไฟล์ JSON ต่อโปรเจกต์ใน storage (`vfx_projects/<email>/<id>.json`, `src/lib/vfx/types.ts` + `store.ts`) — เพราะระบบไม่มีช่องรัน DDL และห้ามให้ deploy รอขั้นตอนมือ · แบบตาราง (`vfx_projects/vfx_shots/vfx_layers`) อยู่ที่ `scripts/sql/vfx_phase1.sql` รันใน Supabase SQL editor เมื่อพร้อม แล้วเปลี่ยนแค่ `store.ts` · งานเลเยอร์ = แถว `generations` (`mode:'vfx-layer'` + `vfx_project_id/shot_id/layer_id`) ให้ตัวเดินงาน Prereq A + `video-status` พาไปจบ (ไม่มี worker ใหม่)
  > **Pipeline (`src/lib/vfx/pipeline.ts`):** ① วิเคราะห์: ffmpeg `select=gt(scene,0.4)` แบ่งช็อต (ยาวเกิน 15 วิ หั่นต่อ) → ตัดเซกเมนต์ + โปสเตอร์ขึ้น storage → Gemini VLM จดคน/กล้อง/แสงต่อช็อต (advisory) ② วางแผน: Gemini เขียน prompt ฉากหลังต่อช็อตจากบรีฟ+โน้ตช็อต (LLM วางแผนอย่างเดียว ไม่เรียกโมเดล) → เลเยอร์ matte/background/grade/composite (หรือ edit/grade สำหรับ O3) ราคาจาก registry ③ ยืนยัน: `/api/vfx/run` หักเครดิต**เท่ากับที่แสดง** (ส่งเลขไม่ตรง → 409 ให้ดูยอดใหม่) แล้วส่งงาน ④ เสร็จ: veed คืน color+alpha → **คัดลอกเข้า storage ของเรา** (URL ของ Fal ไม่ถาวร) → composite → ช็อต `review` ⑤ ตรวจ: อนุมัติ / **gen ใหม่เฉพาะฉากหลัง (3 เครดิต, ไม่รัน matte ซ้ำ — ใช้ artifact เดิม)** / เปลี่ยน grade (ฟรี) / เรนเดอร์ใหม่ทั้งช็อต ⑥ ส่งออก: รวมช็อตที่อนุมัติผ่าน merge-dialogue (normalize + color match)
  > **E2E production (5 ก.ย., 119 วิทั้งสาย):** สร้าง+วิเคราะห์ 12 วิ → แผน 20 เครดิต → ยืนยันผิดยอด → 409 ✓ → รัน → review ที่ 98 วิ → redo ฉากหลัง "jazz bar" 18 วิ: **matte v1 คงเดิม composite v2** ✓ → อนุมัติ → ส่งออก ✓ · ภาพ: คนอยู่ในบาร์แจ๊สโคมอุ่นสมจริง
  > **Acceptance Phase 1:** ฟุตเทจ 7.2 วิ → คลิปเปลี่ยนฉาก < 2 นาที ✓ · regen เฉพาะ background ไม่รัน matte ซ้ำ ✓ · เครดิตหักตรง estimate 100% (บังคับด้วย 409) ✓ · ปิดแท็บแล้วงานเดินจนจบ — กลไกเดียวกับ Prereq A (ยังไม่ทดสอบซ้ำในรอบนี้) · โหมดเดิมทำงานเหมือนเดิม (build ผ่าน, merge/dialogue ทดสอบแล้ววันเดียวกัน) ✓
  > **ยังไม่ทำ / ข้อจำกัด:** ตารางจริงยังไม่รัน (เอกสาร JSON ไปก่อน) · ฟุตเทจ ≤60 วิ ≤12 ช็อต · grade เป็น preset (ยังไม่ auto-match กับฉาก) · **หมายเหตุ Gemini:** `gemini-1.5-flash`/`2.0-flash` ถูกปลดแล้ว (404) — pipeline VFX ใช้ `gemini-3.6-flash` แล้ว (commit `0f62a45`, โน้ตช็อตกลับมาทำงาน: "portrait shot… soft key light from front left") แต่เส้นทางเดิม 5 จุด (enhancer ของ generate-video/image/prompt, train-lora) ยังอ้างชื่อเก่าและ fallback ไป OpenAI เงียบ — งานแยกรอทำ · ยังไม่มี VLM QA/ธง · ยังไม่มีลายน้ำ (ไม่มี character layer ใน Phase นี้)
- **Phase 2**: fx layer (เริ่มจากคลัง webm alpha) + relight (LightX) + regen เฉพาะเลเยอร์ + versioning
  > **✅ สร้างแล้ว 5 ก.ย. 2569** (commits `5231702`, `ce8f5ba`, +blend fix) — ปรับจากสเปคเดิม 2 จุดด้วยเหตุผลที่พิสูจน์แล้ว:
  > **① คลัง FX = คลิป "บนพื้นดำ" + blend แบบ screen แทน webm alpha** — ffmpeg 4.1 บน Vercel ถอด VP9 alpha ไม่ได้ (กฎเหล็กข้อ 3) แต่ FX เชิงแสง/บรรยากาศ (ควัน ประกายไฟ ฝน แสงรั่ว ฝุ่น) ซ้อนด้วย screen บนพื้นดำได้โดยไม่ต้องมี alpha เลย · คลังตั้งต้น 5 ตัว สร้างด้วย Grok text-to-video ($0.01/วิ, 6 วิ/ตัว ≈ $0.06) ตรวจขอบเฟรมดำจริง (luma 0.0) · manifest `vfx_fx/library.json` · ผู้ดูแลเพิ่มได้ผ่าน `POST /api/vfx/fx` · เลือกได้ ≤3 ต่อช็อต ปรับความเข้ม/หลังคน-หน้าคน/โหมด blend · **ฟรี** (ffmpeg ล้วน ประกอบใหม่จาก matte เดิม)
  > **② relight → grade "เข้ากับฉาก" (match) แทน LightX** (LightX คุณภาพไม่ผ่านตั้งแต่รอบพิสูจน์) — วัดสมดุลสีของ**เฉพาะตัวคน** (คนบนพื้นดำ ÷ ค่าเฉลี่ย alpha) เทียบภาพฉาก แล้วปรับ white balance ของคนเข้าหา 60% clamp ±15% ไม่แตะ exposure
  > **versioning/regen:** ทุกเลเยอร์เก็บ history 5 เวอร์ชัน · กดชิปเลเยอร์เห็นเวอร์ชันก่อนหน้า → **ย้อนกลับ** แล้วประกอบใหม่ให้ · ตัดคนใหม่ (redo_matte, หักตามราคา matte) · gen ฉากหลังใหม่ (3 cr) · เปลี่ยน grade/FX (ฟรี)
  > **E2E production:** set_fx ควัน(หลัง)+ประกายไฟ(หน้า) 27 วิ → regrade match 22 วิ → history [5,4] → rollback→v5 ✓ (matte v1 ไม่เคยรันซ้ำตลอด 7 เวอร์ชัน)
  > **บทเรียนใหม่ (แก้แล้ว):** ③ `blend=screen` บน yuv420p ทำภาพ**ม่วงทั้งเฟรม** (screen โครมากับค่ากลาง 128 ของ FX ดัน U/V ไป 191) — ต้อง `format=gbrp` ก่อน blend แล้วกลับ yuv420p ④ `setLayerOutput` เคยเก็บ history เฉพาะเมื่อ status=done แต่ผู้เรียกตั้ง processing ไว้ก่อน → history หายทุกครั้ง
- **Phase 3**: character layer + consent flow + watermark + QA VLM
  > **เริ่ม 5 ก.ย. 2569 (ค่ำ) — ด่านพิสูจน์โมเดลก่อนสร้าง UI:**
  > ❌ **Kling O3 Pro video edit + `elements` (@Element1) ไม่เปลี่ยนคน** — ยิงจริง 7.2 วิ $1.18: งานสำเร็จ ได้ผู้หญิงคนเดิมเรนเดอร์ใหม่ 1236×1672 ทั้งที่ prompt สั่งแทนที่ด้วย @Element1 (ใบหน้าชาย) · ไม่ใช่การปฏิเสธนโยบาย (ต่างจาก Seedance) แต่ elements ของ O3 ดูเหมือนมีไว้ "เพิ่ม" ตัวละคร/วัตถุ ไม่ใช่แทนคนในฟุตเทจ → ปิดไว้ใน registry (`char-o3-element`, verified:false)
  > ✅ **Kling Motion Control ผ่าน** (`v2.6/standard/motion-control`): ภาพชาย + ฟุตเทจครู 7.2 วิ → ชายทำท่า/สีหน้า/ขยับปากตามฟุตเทจ 816×1104 ใน 364 วิ **$0.49 ($0.068/วิ)** · เฟรมแน่นตามภาพอ้างอิง (แนะนำภาพครึ่งตัว) · ฉากหลังมาจากภาพอ้างอิง → ส่งต่อ veed + composite = character layer ครบวงจร (เปลี่ยนทั้งหน้าและชุด) → **เครื่องยนต์ character ของ Phase 3**
  > **✅ E2E production ผ่าน (6 ก.ย. 02:45):** consent ไม่ติ๊ก → 400 ✓ · consent ผ่านคัดกรองบุคคลสาธารณะ ✓ · set_character → Motion Control 200 วิ → matte ใหม่บนคลิปนักแสดง → composite v9 (ฉากบาร์แจ๊ส + ประกายไฟ + match) · **ลายน้ำโลโก้มุมล่างขวา + metadata** `comment: AI character edit · consent cst_… · project … · model char-motion-control` ✓ · **QC 3/5 ติดธง ขอบตัดหลุด/แสงไม่เข้าฉาก/สิ่งแปลกปลอม** พร้อมโน้ตไทย — ตรงกับที่ตาเห็น (ขอบตัดจากคลิป Motion Control หยาบกว่าฟุตเทจจริง) และไม่บล็อกงาน ✓ · เครดิตรวมรอบนี้ 8×7 + 2×7 = 70
  > บทเรียน: Gemini 3.x ใช้โทเค็นคิดก่อน — ต้องขอ `responseMimeType: application/json` + `thinkingLevel: low` + maxOutputTokens ≥256 ไม่งั้นได้แค่ "```json" (คัดกรองล้มเหลวแบบปิด) · `thinkingBudget` ถูกปฏิเสธในรุ่นนี้ · fluent-ffmpeg ตัดออปชันตามช่องว่าง — `-metadata comment=…` ต้องส่งเป็น 2 อาร์กิวเมนต์
  > **สร้างแล้ว (commit Phase 3):** เลเยอร์ `character` รันก่อนทุกเลเยอร์ คลิปนักแสดงใหม่กลายเป็นต้นทางของ matte/edit · **consent record** (`vfx_consents/<email>/<id>.json`, `/api/vfx/consent`): ข้อความยินยอม + ติ๊ก, ชื่อบุคคล, ฐาน (ตัวเอง / หนังสือยินยอมพร้อมไฟล์), **คัดกรองบุคคลสาธารณะด้วย Gemini แล้วปฏิเสธ**, เลเยอร์ตัวละครรันไม่ได้ถ้าไม่มี record ที่ตรงกับภาพ · **ลายน้ำ** โลโก้กึ่งโปร่ง + metadata (consent id / project / shot / model) บังคับทุกเอาต์พุตที่มี character edit (ใส่ไม่ได้ = ไม่ส่งออก) · **VLM QC** 3 เฟรม → flags + คะแนน แสดงบนช็อต ไม่บล็อก · UI: เลือกใบหน้าจาก consent, ฟอร์มยินยอม, ป้าย QC
  > สร้างแล้วระหว่างรอ: `src/lib/vfx/watermark.ts` (โลโก้กึ่งโปร่ง + metadata ระบุ consent/โปรเจกต์/โมเดล — ใช้ overlay PNG ไม่พึ่ง drawtext) · `src/lib/vfx/qa.ts` (VLM QA 3 เฟรม → flags edge_halo/lighting_mismatch/frame_jump/identity_drift/artifact + คะแนน 1–5, ติดธงไม่บล็อก · และตัวคัดกรองบุคคลสาธารณะสำหรับภาพอ้างอิง)
- **Phase 4**: cost optimization (router เลือก provider ตามคุณภาพ/ราคาจากข้อมูลบิลจริง), batch, template ฉากยอดนิยม
  > **✅ สร้างแล้ว 6 ก.ย. 2569** — ① **ราคาจากบิล:** แอดมินอัปโหลด CSV usage ของ Fal (คอลัมน์ `app_id, amount, quantity, unit` — หน่วยที่พบจริง: images / megapixels / processed megapixels / seconds / minutes (sync-lipsync) / units / compute seconds) → `$/หน่วย = รวม amount ÷ รวม quantity` ต่อ endpoint → เก็บ `vfx_billing/rates.json` → `primeRates()` เขียนทับทะเบียนในหน่วยความจำต้นทุกเส้นทางที่คิดราคา VFX (≥2 รายการต่อ endpoint) · กฎเครดิตเดียว **เครดิต = ⌈$ × 115⌉** (ตรงกับค่าที่ตั้งมือไว้ทั้งหมด) ② **Router** (`src/lib/providers/router.ts`): `cheapest()/bestWithin()` เลือกเฉพาะ verified · `recommendEngine()` อ่านโน้ตช็อต (คน ≥2 / กล้องเคลื่อน / ความยาว 3–15 วิ) ตามนโยบาย ประหยัด/สมดุล/คุณภาพ → แผนรับ `engine:'auto'` ③ **เทมเพลตฉาก** 10 ลุคในตัว + "บันทึกลุคนี้เป็นเทมเพลต" จากโปรเจกต์ที่เสร็จ (บรีฟ+เครื่องยนต์+grade+FX+**ภาพฉากคงที่** → ข้าม Flux และรักษาโลเคชันเดียวกันทั้งซีรีส์) ④ **โหมดชุด (batch):** ≤10 ไฟล์ ลุคเดียว → วิเคราะห์+วางแผนทุกไฟล์ เลือกเครื่องยนต์ต่อไฟล์ให้ ยืนยันราคารวมครั้งเดียว แล้ววิ่งผ่าน `/api/vfx/run` ทีละโปรเจกต์ (กฎ 409 เดิม)
  > สิ่งที่ยังไม่ทำ: router ข้ามผู้ให้บริการ (ตอนนี้มี Fal รายเดียวที่พิสูจน์แล้ว) · เทมเพลตยังไม่มีภาพตัวอย่างสำหรับชุดในตัว

### Acceptance ของ Phase 1
- ฟุตเทจ 10 วิ 1080p → ได้คลิปเปลี่ยนฉากหลังใน < 5 นาที
- gen ใหม่เฉพาะ background ไม่รัน matte ซ้ำ (ใช้ artifact เดิม)
- เครดิตหักตรงกับ `estimated_credits` ± 10%
- **กดสร้างแล้วปิดแท็บทันที → งานเดินจนจบเองและขึ้นในคลัง** (พิสูจน์ Prereq A)
- โหมดเดิมของแพลตฟอร์มทำงานเหมือนเดิม (ผ่าน test เดิมทั้งหมด)

---
---

# SPEC ส่วนที่ 2: โหมด "Film Mode" (หนังยาว — สไตล์และสีสม่ำเสมอทุกฉาก)

> โหมดแยกจาก VFX Studio แต่ใช้ pipeline/adapter/job เดิมทั้งหมด
> เริ่มทำหลัง VFX Studio Phase 2 เสร็จ (ต้องมี layer versioning ก่อน)
> หลักการเดียว: **ความสม่ำเสมอต้องอยู่ใน asset ที่ล็อกไว้ ไม่ใช่ใน prompt**
> *(หลักการนี้ตรงกับบทเรียนจริงของระบบทุกข้อ — องศากล้อง/ปากปิด/เสียง: คำสั่งใน prompt ไม่เคยคุมความสม่ำเสมอได้ asset ที่ล็อกคุมได้)*

---

## ขั้น 0 — Audit (ห้ามเขียนโค้ด)

- ยืนยันว่า `vfx_projects / vfx_shots / vfx_layers` และ ModelRouter จาก VFX Studio ใช้งานได้จริง
- ระบุจุดที่ orchestrator รับ reference image และ options — Film Mode จะฉีด "effective style" เข้าจุดนี้
- เสนอว่าจะทำเป็น `project.mode = 'film'` บนตารางเดิม หรือ module `/modules/film` แยก พร้อมเหตุผล **แล้วหยุดรอผมอนุมัติ**
- *หมายเหตุจาก audit 3 ก.ย.: ระบบ scene ของโหมด Dialogue (ฉาก+พื้นหลัง+face tags+เสียงประจำตัวละคร) คือโครง act/scene/shot ยุคแรกที่ควรศึกษาเป็นแบบ; `/api/extract-frame` ที่มีอยู่ = กลไก anchor frame สำเร็จรูป*

---

## ขั้น 1 — ลำดับชั้นและ Data Model

### ลำดับชั้น (สไตล์สืบทอดลงล่าง, override ได้เฉพาะจุด)
```
film → act → scene → shot → layer
```

### ตารางใหม่
- `films` — id, user_id, title, style_bible_id, pinned_models (JSON: task→provider+version+seed+params), status
- `film_acts` — id, film_id, order, style_override (JSON, เช่น exposure -1 stop, lut_id อื่น)
- `film_scenes` — id, act_id, order, location_master_id, time_of_day, weather, anchor_frame_asset_id, style_override (JSON)
- `film_shots` — ต่อยอด `vfx_shots`: เพิ่ม scene_id, prev_shot_id (สำหรับ chaining), effective_style (JSON snapshot ตอนรัน)

### Style Bible (single source of truth — เก็บเป็นข้อมูล ไม่ใช่ข้อความ)
- `style_bibles` — id, film_id, palette (hex[]), lut_asset_id, lighting_rules (JSON: key/fill/ratio/tone), lens (JSON: focal, grain, vignette), aspect, fps, version, locked_at
- `master_assets` — id, film_id, kind (`character`|`location`|`prop`|`fx_preset`), name, sheet_asset_ids[] (ภาพหลายมุมที่อนุมัติแล้ว), element_ref (id ของ element ฝั่ง provider เช่น Kling), lora_asset_id (nullable), version, locked (bool)
  - กฎ: job ใด ๆ ใน Film Mode ต้องอ้างอิง reference จาก `master_assets` ที่ `locked = true` เท่านั้น — ปฏิเสธ reference ลอย ๆ
  - master ที่ถูกใช้แล้ว **ห้ามแก้ทับ** ต้อง bump version และให้ผู้ใช้เลือกว่าจะ re-render shot ที่ใช้เวอร์ชันเก่าหรือไม่
  - *ระบบ `characters` เดิม (sheet หลายมุม + LoRA + consent) คือ master_assets ชนิด character ยุคแรก — ย้าย/เชื่อม ไม่สร้างซ้ำ*

### Continuity DB
- `continuity_state` — id, film_id, scene_id, subject (master_asset_id), state (JSON: wardrobe, injuries, props_held, hair, dirt_level), source (`user`|`auto`), updated_after_shot_id
  - orchestrator **อ่านก่อนวางแผนทุก scene** และเสนอ state ใหม่หลัง shot อนุมัติ (ผู้ใช้ยืนยันก่อนบันทึก)

### QA
- `consistency_checks` — id, shot_id, layer_id, anchor_asset_id, style_distance (float, CLIP/DINO), color_delta_e (float), histogram_score, passed (bool), threshold_used (JSON), auto_retry_count

---

## ขั้น 1 — Style Resolver

ฟังก์ชัน `resolveEffectiveStyle(shot_id)`:
1. โหลด style_bible ของ film
2. merge act.style_override → scene.style_override → shot.style_override (ชั้นล่างชนะเฉพาะ key ที่ระบุ)
3. แนบ master_assets ที่ scene/shot อ้างอิง + continuity_state ปัจจุบันของ subject เหล่านั้น
4. แนบ pinned_models
5. คืน JSON snapshot → บันทึกลง `film_shots.effective_style` (ใช้ audit ย้อนหลังได้ว่า shot นี้ gen ด้วยอะไร)

orchestrator รับ effective_style นี้แทนการรับ reference/prompt ตรงจากผู้ใช้

---

## ขั้น 1 — Color Pipeline (แยกสีออกจาก generation)

- ทุก generative layer สั่งด้วยโทนกลาง (`neutral_grade: true` ใน prompt/options) — ห้ามใส่คำสั่งสีหนัก ๆ ใน prompt
- ขั้น `grade` เป็น deterministic 100%: ffmpeg + LUT จาก style_bible (หรือ act override) + color-match กับ `scene.anchor_frame` — *ffmpeg 2018 บน Vercel: ตรวจว่า `lut3d`/`haldclut` มีจริงผ่าน diag ก่อน (กฎเหล็กข้อ 3)*
- anchor_frame ของแต่ละ scene = เฟรมที่ผู้ใช้อนุมัติจาก shot แรกของ scene; shot ถัดไปทั้งหมด match มาหาเฟรมนี้
- เก็บ pre-grade และ post-grade แยก asset เพื่อ re-grade ทั้งเรื่องได้โดยไม่ต้อง gen ใหม่
- *ควิกวินที่อนุมัติแล้ว: ยก anchor color-match ไปใส่ merge-dialogue ก่อน Film Mode เริ่ม — เป็นการซ้อมจริงของขั้นนี้*

---

## ขั้น 1 — Shot Chaining

- ใน scene เดียวกัน `film_shots.prev_shot_id` → worker แนบ last frame ของ shot ก่อนหน้า (post-matte, pre-grade) เป็น reference เสริมนอกเหนือจาก master (น้ำหนักต่ำกว่า master) — *กลไก last-frame มีแล้วใน `/api/extract-frame` (`-sseof -0.3`)*
- ถ้า shot ก่อนหน้ายังไม่ approved → shot ถัดไปรันไม่ได้ (บังคับลำดับภายใน scene; ข้าม scene รันขนานได้)

---

## ขั้น 1 — Consistency QA Worker

หลังทุก generative layer เสร็จ ก่อนเข้าหน้า review:
1. คำนวณ style embedding ของ output เทียบ anchor_frame และ master sheet → `style_distance`
2. คำนวณ ΔE เฉลี่ย + histogram correlation เทียบ anchor (หลัง grade) → `color_delta_e`, `histogram_score`
3. เทียบ threshold ใน style_bible (ค่าเริ่มต้น: style_distance < 0.25, ΔE < 6)
4. ไม่ผ่าน → auto-retry สูงสุด 2 ครั้ง โดยเพิ่ม reference weight / เปลี่ยน seed; ยังไม่ผ่าน → ติดธงในหน้า review พร้อมค่าที่วัดได้
5. VLM ตรวจ continuity เทียบ `continuity_state` (เสื้อผ้า/prop/บาดแผล) → ติดธงถ้าขัดกัน

---

## ขั้น 1 — Model Pinning

- `films.pinned_models` บันทึก provider + model version + seed policy + params ต่อ task ตอนสร้าง film
- ModelRouter ใน Film Mode **ต้องใช้ pinned version** ห้าม auto-upgrade
- เมื่อ provider ประกาศเวอร์ชันใหม่: แจ้งผู้ใช้ → ให้กด "ทดสอบ" → ระบบ re-render 3 shot ตัวอย่างและรัน QA → ผ่านค่อยให้กด "ย้ายทั้งเรื่อง"
- *บทเรียนจริงประกอบ: จุดอ่อนของ Fal คือโมเดลถูกถอด/เปลี่ยน path ได้ (`flux/dev/fill` หายไปเฉยๆ) — pinning ต้องมาคู่กับการตรวจ endpoint ยังมีชีวิตเป็นระยะ*

---

## ขั้น 1 — UI ของ Film Mode

1. **Bible Studio**: สร้าง/แก้ palette, อัปโหลด LUT, กำหนดกฎแสง; สร้าง character/location sheet (gen หลายมุม → เลือก → ล็อก)
2. **Structure**: ต้นไม้ act/scene/shot ลาก-วางได้, ตั้ง override ต่อชั้น, เห็น "effective style" ที่ resolve แล้วต่อ shot
3. **Continuity Board**: ตารางสถานะต่อตัวละครต่อ scene, แก้ด้วยมือได้, ประวัติการเปลี่ยน
4. **Scene Review**: filmstrip ทั้ง scene, คะแนน QA ต่อ shot (สี/สไตล์/continuity), ปุ่ม "re-grade ทั้ง scene" และ "re-gen เฉพาะ layer"
5. **Export**: ต่อ scene / ต่อ act / ทั้งเรื่อง, EDL/XML สำหรับ NLE ภายนอก, รายงาน QA แนบ

---

## Guardrails เพิ่มเติม

- ทุก master ประเภท `character` ที่มาจากคนจริง ต้องผูก consent record เดียวกับ VFX Studio
- ล็อก Bible แล้วแก้ไม่ได้โดยตรง — ต้อง bump version เสมอ (ป้องกันสไตล์เลื่อนโดยไม่รู้ตัวกลางเรื่อง)

---

## ขั้น 2 — ลำดับ Build (รอผมอนุมัติทุก phase)

- **Phase F1**: style_bibles + master_assets + Style Resolver + Bible Studio UI + color pipeline (LUT + anchor match)
  > **สร้างแล้ว 7 ก.ย. 2569** (`src/lib/film/{types,store,resolver,color}.ts`, `/api/film/films`, `/api/film/scenes`, แท็บ "Film Mode") — ตัดสินใจตามขั้น 0: **ไม่แยก module** ใช้ VFX Studio เป็นเครื่องยนต์สร้างช็อต (project ต่อช็อต, plate = master ที่ล็อก, grade none) และเก็บหนังเป็นเอกสาร JSON (`films/<email>/<id>.json`) แบบเดียวกับ VFX จนกว่าจะรันตาราง
  > **Style Bible** เป็นข้อมูล: palette, LUT (.cube), กฎแสง (key/fill/ratio/tone), เลนส์, สัดส่วน/fps, เกณฑ์ ΔE (ค่าเริ่มต้น 6) · **ล็อกแล้วแก้ตรงไม่ได้** → bump เวอร์ชัน เก็บประวัติ · ช็อตสร้างไม่ได้ก่อนล็อก Bible
  > **master_assets**: location/character/prop มี sheet หลายภาพ, version, locked, used_by · ตัวละครจากคนจริงต้องผูก consent เดียวกับ VFX · **job ที่อ้าง reference นอก master หรือ master ที่ยังไม่ล็อกถูกปฏิเสธ** · master ที่ใช้แล้วห้ามแก้ทับ → bump
  > **Resolver**: bible → scene override (exposure/LUT) → shot override เฉพาะ key ที่ระบุ + master + anchor + pinned_models → snapshot `effective_style` บนช็อต · ทุก generative layer ได้ `neutral_prompt_suffix` ไม่มีคำสั่งสี
  > **Color pipeline**: `lut3d` (มีจริงใน ffmpeg 4.1) → anchor match (gain ต่อช่อง + exposure) → วัด **ΔE (CIE76) ของสีเฉลี่ย** เทียบ anchor · pre/post-grade แยกไฟล์ · "grade ทั้งฉาก" ไม่มี generative job · **pinned_models** บันทึกตอนสร้างหนัง (matte/plate/character)
  > **✅ Acceptance F1 บน production (7 ก.ย., 560 วิ):** master นอกทะเบียน → ปฏิเสธ ✓ · master ยังไม่ล็อก → ปฏิเสธ ✓ · ช็อตก่อนล็อก Bible → 409 ✓ · 5 ช็อตจาก master เดียว (17 เครดิต/ช็อต, plate คงที่ ไม่เรียก Flux) → ready ทั้ง 5 ใน 429 วิ · anchor จากช็อต 1 → grade: **ΔE เฉลี่ย 0.59** (< 6) · bump Bible ใส่ LUT .cube → re-grade: `lut3d` ทำงานบน ffmpeg 4.1 ✓ ΔE 0.95 · **ไฟล์ post-grade เปลี่ยนทั้ง 5 แต่เวอร์ชันเลเยอร์ใน VFX ไม่ขยับ = ไม่มี generative job** ✓ · หมายเหตุ: ทดสอบด้วยฟุตเทจเดียวกัน 5 ครั้ง ΔE จึงต่ำมาก การทดสอบกับฟุตเทจต่างมุม/แสงยังต้องทำเมื่อมีฟุตเทจจริง
  > **ทิศทางใหม่ (ทำพร้อมกัน):** เปลี่ยนคำในหน้าเว็บทั้งหมดจาก "ครู/ผู้สอน/ผู้เรียน/สื่อการสอน" เป็นภาษาโปรดักชั่น · **แพ็กเกจเครดิตแยกระดับ** (`src/lib/credits/packages.ts`): Starter ฿590/1,000 cr (economy) · Creator ฿1,590/3,000 (pro) · Studio ฿4,990/10,000 (ultra) · Production ฿13,900/30,000 (ultra) — เครดิต = ⌈$×115⌉ เหมือนเดิม ต่างกันที่จำนวน ราคา/เครดิต และ**ระดับโมเดลที่บัญชีใช้ได้** (O3 edit + Film Mode = ultra, ตัวละคร Motion Control = pro) · แอดมินให้แพ็กเกจได้ในหน้าแอดมิน (เพิ่มเครดิต + ตั้งระดับ) · บัญชีเดิมที่ยังไม่รับแพ็กเกจใช้ได้ทุกระดับ
- **Phase F2**: film/act/scene hierarchy + Structure UI + shot chaining
  > **สร้างแล้ว 8 ก.ย. 2569** — `acts[]` บนเอกสารหนัง (หนังเก่าได้องก์ 1 อัตโนมัติตอนโหลด) · resolver รวม 4 ชั้น film→act→scene→shot (exposure stops บวกสะสม, LUT/แสง/เลนส์ชนะเฉพาะ key) · Structure: เพิ่ม/เปลี่ยนชื่อองก์, ปุ่มเลื่อนขึ้น-ลงองก์/ฉาก/ช็อต, ย้ายฉากข้ามองก์, ปุ่ม ℹ︎ ดู effective style ของช็อต (ใช้ปุ่มเลื่อนแทนลาก-วาง) · **Shot chaining:** ช็อตถัดไปสร้างไม่ได้จนช็อตก่อนหน้าในฉาน "อนุมัติ" (409 `chain_blocked`) · เฟรมสุดท้ายของช็อตก่อน (post-matte pre-grade, `-sseof -0.3`) เก็บเป็น `chain_frame_url` และแนบเป็น reference รอง · เรียงช็อตใหม่ → rewire `prev_shot_id` · re-grade ไม่ถอนการอนุมัติ
  > **✅ ทดสอบ production (8 ก.ย., 150 วิ):** องก์ 2 exposure −0.5 → ช็อตในองก์นั้นได้ effective exposure −0.5 ✓ · ช็อต 2 ก่อนอนุมัติ → 409 chain_blocked ✓ · อนุมัติช็อต 1 → ช็อต 2 สร้างได้พร้อม prev_shot_id + เฟรมสุดท้าย ✓ · เลื่อนช็อต 2 ขึ้น → chain rewired (S2 ไม่มี prev, S1 prev=S2) ✓ · เลื่อนองก์ ✓
- **Phase F3**: consistency QA worker + Scene Review พร้อมคะแนน + auto-retry
  > **สร้างแล้ว 9 ก.ย. 2569** (`src/lib/film/qa.ts`, `0f3f2ae`/`5ffe3af`) — หลัง grade ทุกช็อตถูกวัด 3 ค่าเทียบ anchor ของฉาก (+ plate ของ location master): **ΔE สีเฉลี่ย** (จากขั้น grade, เกณฑ์จาก Bible) · **histogram correlation** (Pearson ของ histogram RGB 16 bin จาก 8 เฟรม @64×64, เกณฑ์ ≥ 0.7) · **style distance** = 1 − ความคล้ายลุค (แสง/พาเลต/คอนทราสต์/เกรน/เลนส์) จาก VLM Gemini เทียบ anchor+master (เกณฑ์ < 0.25; โฮสต์นี้ไม่มี CLIP/DINO จึงใช้ VLM แทน embedding) · ผลเก็บบน `shot.qa` (ค่า, เกณฑ์ที่ใช้, จำนวน retry, หมายเหตุภาษาไทย) · **auto-retry แบบกำหนดได้:** ถ้า ΔE ยังเกินเกณฑ์ grade ซ้ำด้วย strength 1.15 แล้ว 1.30 (สูงสุด 2 ครั้ง) **เก็บผลที่ ΔE ต่ำสุด** (วัดจริง: match แรงขึ้นอาจเด้ง 0.97 → 1.31) ภายในงบเวลา 120 วิ ของ function (grade+QA ≈ 30–40 วิ/ช็อต; งบ 170 วิ วัดได้ 281 วิ ใกล้เพดาน 300 เกินไป) · ค่าที่วัดไม่ได้ (Gemini ล่ม) เป็น null และไม่ถือว่าตก · **Scene Review:** กล่อง QA ผ่าน/ติดธง ต่อช็อต (ค่าที่เกินเกณฑ์เป็นตัวหนา + หมายเหตุ) สรุปฉาก "ติดธง n/N" · ปุ่ม **"gen ตัดคนใหม่"** = `regen_layer` re-run เฉพาะเลเยอร์ matte ของโปรเจกต์ VFX ของช็อตนั้น (คิดราคา matte, ฉากหลัง/plate/grade ไม่เปลี่ยน) → ช็อตกลับเป็น processing → sync → grade ใหม่
  > **✅ ทดสอบ production (9 ก.ย., 383 วิ):** grade+QA 5 ช็อต 190 วิ → ΔE 0.86–0.97, hist 0.95, style 0.02 ("สม่ำเสมอ") ผ่านทั้ง 5 ✓ · regen matte ช็อต 5 → processing → ready → grade ใหม่ ΔE 0.86 ผ่าน ✓ · **เส้นทาง retry/ธง** (bump Bible เกณฑ์ 0.3 ไม่มี generative job): retry 2/2/1/0/0 ตามงบเวลา (grade ≈ 190 วิ) เก็บผลดีสุด: ช็อต 1 ΔE 0.98 → 0.70, ช็อต 2 1.31 → 0.91 ✓ ติดธง 5/5 บนเอกสาร (`qa.passed=false`, `threshold_used 0.3`) ✓ คืนเกณฑ์ 6 → ผ่าน 5/5 ✓ · หมายเหตุ: ฟุตเทจทดสอบเป็นคลิปเดียวกัน 5 ครั้ง ค่าจึงใกล้กันมาก เกณฑ์ histogram/style ต้องปรับเมื่อมีฟุตเทจต่างมุม/แสงจริง
- **Phase F4**: continuity_state + Continuity Board + VLM continuity check
  > **สร้างแล้ว 9 ก.ย. 2569** (`src/lib/film/continuity.ts`, `1169096`/`e72b88f`) — **Continuity DB** = `film.continuity[]` หนึ่งแถวต่อ (ฉาก, subject) โดย subject = master ตัวละคร/พร็อพ (ฉากเลือก subject ได้ผ่าน `subject_master_ids`; ไม่ตั้ง = ทุกตัว) state เป็นข้อมูล: เสื้อผ้า ทรงผม บาดแผล พร็อพที่ถือ ระดับความสกปรก หมายเหตุ · `source` user|auto · `updated_after_shot_id` · ประวัติต่อช่อง · **สืบทอด:** ฉากที่ไม่มี state ของ subject ใช้ค่าล่าสุดของฉากก่อนหน้าตามลำดับหนัง (องก์ → ฉาก) · **Resolver ขั้น 3:** `effective_style.continuity[]` + `continuity_prompt` แนบให้ทุกช็อตที่สร้าง (instruction ของโปรเจกต์ VFX ต่อท้าย `; continuity: …`) · **VLM check** (`check_continuity` ทั้งฉาก/ช็อตเดียว): Gemini ดูเฟรมกลาง+เฟรมสุดท้ายของช็อต + sheet ของ subject + state ที่ต้องตรง → ต่อ subject: อยู่ในเฟรม/ตรง/ปัญหา (ไทย)/state ที่เห็นในเฟรมสุดท้าย → `shot.continuity` ธงบนการ์ดช็อต (advisory) · **ข้อเสนอหลังอนุมัติ:** `approve_shot` เรียก VLM แล้วสร้าง `continuity_proposals[]` เมื่อบอร์ดยังว่างหรือช็อตขัดกับ state — **ผู้ใช้ยืนยัน/ปฏิเสธก่อนบันทึก** (บันทึกเป็น source auto + ช็อตต้นทาง; ค่าเดิมเข้าประวัติ) · **Continuity Board** ใน Film Mode: ตาราง subject × ฉาก แก้ในช่องได้ (ตั้งเอง/สืบทอด/ล้าง) ประวัติต่อช่อง ปุ่มเอา subject ออกจากฉาก การ์ดข้อเสนอด้านบน · ปุ่ม "ตรวจ continuity" ต่อฉาก + ธงต่อช็อต · `preview_style` คืน snapshot ของ resolver โดยไม่สร้างงาน
  > **✅ ทดสอบ production (9 ก.ย., 137 วิ, ไม่มี generative job):** เพิ่ม master ตัวละครจาก consent + ล็อก ✓ · resolver: ยังไม่มี state → prompt ว่าง ✓ · ตั้ง state ผิด (ชุดเกราะอัศวิน+ดาบ+สกปรกมาก) → prompt มีข้อความ ✓ → VLM ติดธง 1/1 พร้อมเหตุผลไทย ("สวมเสื้อสีน้ำเงินเข้มแทนชุดเกราะ / ไม่มีดาบ / สะอาดเกินไป") ✓ · ล้าง state → อนุมัติช็อต 1 ใหม่ → ข้อเสนอ 1 รายการ (เสื้อผ้า/ทรงผมที่เห็นจริง) ✓ → ยืนยัน → แถว source=auto ผูกช็อตต้นทาง ✓ · ฉากในองก์ถัดไปสืบทอด state (source auto, inherited_from = ฉากกลางวัน) และได้ continuity_prompt ✓ (ระหว่างทดสอบพบว่าองก์ 2 ถูกเลื่อนไปอยู่ก่อนองก์ 1 จากการทดสอบ F2 จึงไม่สืบทอด — ถูกต้องตามลำดับหนัง; เลื่อนกลับแล้ว) · ตรวจทั้งฉากกับ state ที่สังเกตได้ → ผ่าน 5/5 ✓ · แก้: VLM ตอบ "none" ให้ถือเป็นช่องว่าง
- **Phase F5**: model pinning + migration flow + export EDL/XML
  > **สร้างแล้ว 10 ก.ย. 2569** (`5a9e414`, `63cd01a`) — **Pinning บังคับใช้จริง:** โปรเจกต์ VFX ที่ Film Mode สร้างมี `pinned` (task → model id จาก `film.pinned_models`) และไปป์ไลน์ใช้ `pinnedModel(project, task)` แทนค่าเริ่มต้นของ registry ทุกจุด (matte / plate / character) · **Liveness** `src/lib/providers/liveness.ts`: คิวของ Fal รับทุก path จึงพิสูจน์ด้วยการยิง body ว่าง → ผลลัพธ์ 422 "Field required" = มีชีวิต, 404 "Path … not found" = หายไป (ไม่มีค่าใช้จ่าย; วัดจริง: veed/bria 422, `flux/dev/fill` 404) · `check_models` รายงานต่อ task: มีชีวิต/ตรง registry/ตัวเลือกที่พิสูจน์แล้วของงานเดียวกัน (โมเดลที่ endpoint ใช้ได้แต่ไปป์ไลน์กินผลลัพธ์ไม่ได้ติดธง `incompatible` ใน registry และไม่ถูกเสนอ) · **Migration flow:** เสนอย้าย (matte/character เท่านั้น; plate มาจาก master) → "ทดสอบ 3 ช็อต" สร้างโปรเจกต์ VFX ใหม่จากช็อตตัวอย่าง (ช็อตจริงไม่ถูกแตะ, หักเครดิตตามราคาโมเดลใหม่) → `sync_migration` grade ตัวอย่างกับ anchor ของฉาก + QA F3 → `tested` + `passed` → "ย้ายทั้งเรื่อง" เปลี่ยน pin (เก็บ `migrated_from`) เลือก re-render ช็อตเดิมทั้งหมดได้ · **ด่าน:** apply ก่อนทดสอบ/ตัวอย่างไม่ผ่าน → 409; บังคับย้ายได้แต่บันทึก `forced` + audit `film_migration_applied` · **Export** `/api/film/export` ต่อฉาก/องก์/ทั้งเรื่อง: CMX3600 EDL (record เริ่ม 01:00:00:00, NDF ที่ fps ของ Bible) + FCP7 XML (xmeml v5, clipitem ต่อช็อต) + manifest.json (ชื่อไฟล์คงที่ `A01_S01_SH02.mp4` ↔ signed URL ↔ ฉาก/ช็อต/สถานะ/โมเดล) + รายงาน QA (.json/.csv: ΔE/hist/style/continuity/retry/master/model ต่อช็อต + สรุป) + MP4 รวมผ่าน merge-dialogue เมื่อเลือก · UI: แผง "โมเดลที่ปักหมุด" + การ์ดย้าย + แผงส่งออกท้ายหน้า
  > **✅ ทดสอบ production (10 ก.ย., 370 วิ):** path ที่ถูกถอด → alive=false ✓ · pinned 3 งาน alive ✓ ตรง registry ✓ · ย้าย matte veed→bria: apply ก่อนทดสอบ 409 ✓ · ทดสอบ 2 ตัวอย่าง (96 cr) → ล้มเหลวทั้งคู่ "ผลตัดคนไม่ครบ (color+alpha)" → tested passed=false → apply 409 ✓ → บังคับย้าย 200 forced=true ✓ · ย้ายกลับ bria→veed: ทดสอบ 2 ตัวอย่าง (32 cr) → ΔE 0.97/0.86 QA ผ่าน → passed=true → apply 200 ✓ pin กลับเป็น veed พร้อม migrated_from ✓ · export ทั้งเรื่อง 6 ช็อต 43.02s: EDL/XML(6 clipitem)/CSV 6 แถว/manifest ✓ · export ฉาก + render MP4 ✓ · แก้หลังทดสอบ: ชื่อคลิปชนกันข้ามองก์ → ใส่เลของก์, ตัวอย่างเติมให้ครบ 3, Bria ถูกกันออกจากตัวเลือกด้วย `incompatible`
  > **หมายเหตุ:** ฟิล์มทดสอบมีโปรเจกต์ VFX ตัวอย่างจากการย้าย 4 โปรเจกต์ (ชื่อ "… · ทดสอบ …") และ migration 2 รายการสถานะ applied

### เพิ่มโมเดล 10 ก.ย. 2569 — MiniMax H3 (Hailuo 03) "KRUTH Candid"
- ผู้ใช้ขอ "สร้างเนื้อหาที่เป็น amateur" = **ลุคมือถือถ่ายเอง / UGC** (สั่นนิด ๆ, autofocus วูบ, แสงธรรมชาติ, ไม่เกรดสี) — อยู่ในโหมด Standard เท่านั้น `enable_safety_checker: true` เสมอ และผ่าน moderation เดิม
- Fal app id ใช้ prefix `minimax/` (ไม่ใช่ `fal-ai/minimax/`): `minimax/h3/image-to-video`, `minimax/h3/text-to-video` (พิสูจน์ทั้งคู่ 10 ก.ย.: 5.18s 1344×768 24fps + AAC stereo ~190 วิ), `minimax/h3-max/*`, `minimax/h3-max-turbo/image-to-video` (ยังไม่ยิง)
- ราคาป้ายต่อวินาที: 480P $0.05 → 6 cr · 768P $0.06 → 7 · 2K $0.13 → 15 · 4K $0.16 → 19 (2K/4K = upscale จาก 768P) · ความยาว 5–15 วิ (จำนวนเต็ม) · มีเสียงในตัว → ไม่ต้องทำ ambient pass (`modelScoresItself`)
- โค้ด: registry `minimax-h3-i2v`/`minimax-h3-t2v` (verified) + `minimax-h3max-i2v` (ยังไม่พิสูจน์) · `generate-video` engine `minimax-h3` (`h3_resolution` จากฟอร์ม) · Mode1Form ตัวเลือก "📱 KRUTH Candid" + เลือกความละเอียด + visual style "Amateur / UGC" (prompt suffix) · ทดสอบผ่าน route จริงบน production: ดูบันทึกใน memory

### Acceptance ของ Phase F1
- สร้าง scene 5 shot จาก location master เดียวกัน → ΔE เฉลี่ยระหว่าง shot หลัง grade < 6
- เปลี่ยน LUT ใน Bible แล้ว re-grade ทั้ง scene โดยไม่มี generative job รันซ้ำ
- job ที่อ้างอิงภาพนอก master_assets ถูกปฏิเสธพร้อมข้อความชัดเจน
- VFX Studio (โหมดเดิม) ผ่าน test เดิมทั้งหมด

---

## ภาคผนวก B: โครงสร้างความปลอดภัยโหมด Standard (7 ก.ย. 2569)

> ที่มา: ผู้ใช้เสนอแผนโปรดักต์ 2 โหมด (Standard / Verified Character-Mature) ข้อสรุป: **โค้ดเบสนี้มีโหมด Standard เท่านั้น** โหมด Mature ถ้าจะมีต้องเป็นโปรดักต์แยก และเปิดได้เมื่อมีความเห็นทางกฎหมาย (ป.อาญา ม.287, พ.ร.บ.คอมฯ ม.14(4)), ผู้ให้บริการ KYC ยืนยันอายุ และช่องทางชำระเงินที่รับเนื้อหาผู้ใหญ่ — ยังไม่มีข้อสรุปทั้งสาม · ส่วนโครงสร้างความปลอดภัยของแผนสร้างให้ที่นี่เพราะมีประโยชน์กับ Standard ทันที และ fork ไปใช้ได้

- **นโยบาย** `docs/CONTENT_POLICY.md` v2026-09-07 (ขอบเขต, สิ่งที่บล็อกถาวร, ภาพลักษณ์บุคคลจริง, provenance, รายงาน/takedown, บทบาท, ความลับ, retention)
- **Moderation ก่อนส่งงาน** `src/lib/moderation.ts`: ชั้น 1 regex บล็อกแข็ง (เพศ+ผู้เยาว์, ความรุนแรงทางเพศ — ไม่ส่งข้อความนี้ไปโมเดลใดเลย) → ชั้น 2 Gemini จำแนก 6 หมวด (fail-open เมื่อ Gemini ล่ม เพราะตัวกรองผู้ให้บริการยังอยู่) · ผูกกับ generate-image / generate-video / generate-beat / vfx plan / vfx batch → HTTP 422 `policy_block` · **ไม่มีการแก้คำขอเพื่อเลี่ยงตัวกรองที่ใดในระบบ**
- **Audit log** `src/lib/audit.ts`: append-only ไฟล์ต่อเหตุการณ์ `audit/<วัน>/` (moderation_block, report_*, takedown, consent_*, package_granted, role_changed …) ดูรายวันในหน้าแอดมิน
- **รายงาน/takedown** `src/lib/reports.ts`, ปุ่ม 🚩 ในคลังผลงาน → `/api/report` → คิว `/api/admin/moderation` (reviewer|admin): ยกคำร้อง / ลบผลงาน (ลบไฟล์จริง + แถว) / ลบ+ระงับบัญชี (whitelist expires_at ย้อนหลัง) / ระงับตัวละคร — ทุกคำตัดสินเข้า audit
- **Provenance** ทุก generation ที่เสร็จได้ `metadata.provenance {ai_generated, model_endpoint, created_by, policy_version, at, consent_id?}` (ประทับใน video-status)
- **บทบาท reviewer** เพิ่มใน `/api/admin/role` (`role: admin|reviewer|user`)
- **ความลับ** `scripts/check-secrets.js` รันก่อน build เตือนตัวแปรลับที่ชื่อ `NEXT_PUBLIC_*` (พบ 6 ตัวใน .env.local — โค้ดฝั่ง server อ่านชื่อฝั่ง server ก่อนแล้ว **ควรเปลี่ยนชื่อบน Vercel** เป็น FAL_KEY, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_API_KEY, BOTNOI_TOKEN, AZURE_SPEECH_KEY แล้วตั้ง `SECRETS_STRICT=1` ให้ build ล้มเมื่อพลาด) · คีย์ Gemini ที่เคยวางในแชทควรหมุนใหม่
- **Private storage (8 ก.ย.):** bucket ใหม่ `kruth-private` (ไม่มี public URL) — VFX Studio และ Film Mode ใช้กับไฟล์ใหม่ทั้งหมด (ฟุตเทจ ภาพอ้างอิง ใบหน้า หนังสือยินยอม LUT และผลงานทุกเลเยอร์) · อ้างอิงในเอกสารเป็น `private://<path>` · `resolveUrl()` ออก signed URL อายุ 1 ชม. ทุกจุดที่ URL ออกจากระบบ (ส่ง Fal, ffmpeg ดึงไฟล์, merge, QA/คัดกรองใบหน้า) · `signDeep()` เซ็นทั้งเอกสารตอน GET แล้ว UI อ่านซ้ำหลังทุกการแก้ · ใบหน้าของ consent มาจากบันทึกฝั่งเซิร์ฟเวอร์เท่านั้น · video-status ไม่เขียนสำเนา public ของงานเลเยอร์และซ่อนแถวจากคลัง · ไฟล์เก่าที่เป็น public ยังใช้ได้ตามเดิม · เปิด/ปิดด้วย `PRIVATE_OUTPUTS` · **ทดสอบ production ผ่าน (8 ก.ย., 132 วิ):** เปิด object ส่วนตัวผ่าน URL public → HTTP 400 ✓ · สร้าง/วางแผน/รันจากฟุตเทจส่วนตัว (veed รับ signed URL) → review ✓ · เอกสารเก็บ `private://` ทั้ง footage/output ส่วน API ส่ง signed URL ✓ · แถวงานเลเยอร์ `video_url=null hidden=true` ✓ · export ช็อตเดียวเก็บ ref แล้วเซ็นตอนอ่าน ✓ · บทเรียน: Supabase ปฏิเสธ `fileSizeLimit` ของ bucket ที่สูงกว่าเพดานโปรเจกต์ — สร้าง bucket โดยไม่ตั้งเพดาน · **ข้อจำกัดที่ยังอยู่:** ระบบตรวจสิทธิ์ยังอิงอีเมลที่ client ส่งมา (ไม่มีการยืนยัน session ฝั่งเซิร์ฟเวอร์) — signed URL ทำให้ไฟล์ไม่ถูกเปิดสาธารณะ แต่การป้องกันบัญชีปลอมต้องทำ server-side session ต่อไป · ผลงาน export หลายช็อต (ผ่าน merge-dialogue) และโหมดเดิมทั้งหมดยังอยู่ bucket public
- **Server-side session verification (8 ก.ย.):** `src/lib/auth-server.ts` — เบราว์เซอร์แนบ Supabase access token ทุกคำขอ `/api/*` (fetch interceptor ใน auth-context) เซิร์ฟเวอร์ตรวจกับ Supabase แล้วเทียบกับ `user_email` ที่อ้าง ไม่ตรง → 403, token เสีย → 401 · `guard()` ใส่ใน 24 เส้นทาง (vfx/*, film/*, consent, report, admin/*, generate-*, merge, face-motion, train-lora) · เส้นทางภายใน (cron, video-status) ไม่กระทบ · **โหมดเปลี่ยนผ่าน:** คำขอที่ไม่มี token ยังผ่านพร้อม log จนกว่าจะตั้ง `SESSION_STRICT=1` บน Vercel (แนะนำตั้งหลังยืนยันว่าหน้าเว็บส่ง token ครบ)
- **Character Registry (8 ก.ย.):** `src/lib/registry.ts` — เรคอร์ดต่อตัวละคร (JSON `registry/characters/<id>.json`): แหล่งที่มา generated/uploaded/trained (อนุมานจาก provenance ของ generations), ภาพทุกมุมพร้อม sha256 + งานต้นทาง/โมเดล, ข้อมูล LoRA, consent id, สถานะตรวจ **draft → under_review → active → disabled** พร้อมประวัติและ audit · สร้างอัตโนมัติตอนสร้างตัวละคร ตัวละครเก่ากด "ขึ้นทะเบียน" ได้ · เจ้าของกด "ส่งตรวจ" (ภาพคนจริงต้องผูก consent ก่อน) · ผู้ตรวจอนุมัติ/ส่งกลับ/ระงับในแอดมิน · **ด่านตอนสร้างงาน** (generate-image/video): ตัวละครที่ถูกระงับถูกปฏิเสธเสมอก่อนเรียกโมเดล ตัวละครที่ยังไม่ผ่านตรวจถูกปฏิเสธเมื่อตั้ง `REGISTRY_ENFORCE=1` (ตอนนี้ปล่อยผ่านพร้อม log) · คำสั่งระงับจาก moderation และจากคิวทะเบียนเขียนทั้งทะเบียนและ flag `is_disabled` ของตาราง characters (เปิดตรวจใหม่ → ปลด flag) · **ทดสอบ production ผ่าน (8 ก.ย.):** สร้าง → เรคอร์ด draft/uploaded พร้อม sha256 ✓ · ส่งตรวจไม่มี consent → 400 ✓ · ผูก consent → ส่งตรวจ → under_review ในคิว ✓ → อนุมัติ active ✓ → ระงับ ✓ → generate-image ด้วยตัวละครที่ระงับ → 403 ก่อนเรียกโมเดล ✓ · **บั๊กเดิมที่พบ:** `/api/characters/create` insert คอลัมน์ `lora_dataset_path` ที่ไม่มีจริง → สร้างตัวละครล้มเหลว 500 ทุกครั้ง แก้แล้ว (`e781fbc`)
- **Fal webhook (8 ก.ย.):** ทุก `falSubmit` แนบ `fal_webhook=<app>/api/webhooks/fal` · handler ตรวจลายเซ็น ED25519 กับ JWKS ของ Fal, หาแถว generation จาก request id (งานหลักหรือเฟส lipsync/ambient/face-restore) แล้วเรียก `/api/video-status` ให้จบงานทันที — **body ของ callback ไม่ถูกใช้เป็นข้อมูล** (เป็นแค่ trigger ให้ไปอ่านสถานะจาก Fal เอง) callback ปลอม/ไม่รู้จัก → ตอบ 200 แล้วเฉย · polling จากเบราว์เซอร์และ cron 5 นาทียังเป็นสำรอง · ปิดได้ด้วย `FAL_WEBHOOKS=0`
- **ยังไม่ทำ:** ตาราง registry จริง (เอกสาร JSON ไปก่อน เหมือน VFX) · Film Mode ครบ F1–F5 แล้ว

## ภาคผนวก: บันทึกการปรับปรุง 3 ก.ย. 2569

| เรื่อง | เดิม | ปรับเป็น | เหตุผล |
|---|---|---|---|
| โครงงาน | ทึกทักว่ามี job queue | เพิ่ม Prereq A (ตารางงาน + cron) | ระบบจริงเดินงานด้วยเบราว์เซอร์ผู้ใช้ — งานแขวนเมื่อปิดแท็บ (เกิดจริง 3 ก.ย.) |
| ตาราง provider | ชื่อโมเดลคาดการณ์ | ระบุ endpoint จริง + ราคาป้าย (ตรวจสดจาก Fal) | Kling O3 / Wan 2.7 / Happy Horse / LightX มาจริงแล้วทั้งหมด |
| fx layer | gen เป็นหลัก stock เป็นรอง | สลับ: stock webm alpha เป็นหลัก | ถูกกว่า นิ่งกว่า ค่อย gen เมื่อจำเป็น |
| C2PA | บังคับ | metadata + ลายน้ำมองเห็นก่อน | C2PA เต็มรูปบน serverless หนักเกิน Phase แรก |
| VLM QA | ไม่ระบุพฤติกรรม | ติดธง ไม่บล็อก (Phase แรก) | กันผลบวกลวงขวางงาน |
| เศรษฐศาสตร์ | ไม่ระบุ | tier แยกจากเครดิตครู ($3–4/ช็อต 10 วิ) | เครดิตครูปัจจุบันรองรับไม่ได้ |
| ลำดับ build | Phase 1 เต็มเลย | เพิ่ม Phase 0.5 MVP "เปลี่ยนฉากหลังวิดีโอ" + ควิกวิน color-match เข้า dialogue | เก็บผลเร็ว พิสูจน์ท่อจริงก่อนลงทุน UI ใหญ่ |
| Acceptance | 4 ข้อ | +1: ปิดแท็บแล้วงานเดินจนจบเอง | ตัวชี้วัดว่า Prereq A ทำงานจริง |
