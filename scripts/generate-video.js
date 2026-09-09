const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const WIDTH = 1080;
const HEIGHT = 1080;
const SUPERSAMPLE = WIDTH * 3;
const FPS = 30;
const MIN_CLIP_DURATION = 3.0;   // على الأقل 3 ثواني لكل صورة
const MAX_CLIP_DURATION = 3.6;
const MIN_TRANSITION_DURATION = 0.55;
const MAX_TRANSITION_DURATION = 0.85;
const WATERMARK_TEXT = "MasterDXF.com";
const ACCENT_COLOR = "0xFFC107"; // أصفر/برتقالي لافت للكلمات المهمة (FREE, MasterDXF.com)
// zoompan يستعمل خوارزمية تصغير داخلية ضعيفة الجودة ولا يقبل flags=lanczos إطلاقًا.
// لذلك نخليه يخرج بحجم وسيط (2x الحجم النهائي) بدل الحجم النهائي مباشرة، ثم فلتر scale منفصل
// بـ lanczos بعده يدير التصغير الحقيقي عالي الجودة.
const ZOOMPAN_INTERMEDIATE = WIDTH * 2;
// انتقالات مختارة بعناية (4 بدل 12) لثبات الهوية البصرية ومظهر أكثر احترافية بدل التنويع العشوائي.
const TRANSITIONS = ["zoomin", "circleopen", "hblur", "smoothleft"];
const HOOK_DURATION = 2.4;
const OUTRO_DURATION = 1.8;
const BOLD_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"; // fallback افتراضي
const TMP_DIR = "tmp_video_build";
const OUTRO_FILE_1 = path.join(TMP_DIR, "outro_text_1.txt");
const OUTRO_FILE_2 = path.join(TMP_DIR, "outro_text_2.txt");

// ===== دوال التحميل الأصلية — لم يتم تغيير أي شيء فيها =====
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'x-internal-bot-secret': 'masterdxf-publisher-9f3k2m',
        'Referer': 'https://masterdxf.com/'
      }
    };
    https.get(url, options, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`فشل التحميل: ${response.statusCode} من ${url}`));
        return;
      }
      const file = fs.createWriteStream(destPath);
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    }).on('error', (err) => { reject(err); });
  });
}

function wrapText(text, maxCharsPerLine) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length <= maxCharsPerLine) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.join('\n');
}

function wrapLines(text, maxCharsPerLine) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length <= maxCharsPerLine) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

function evenRound(n) {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r + 1;
}

function pickFont() {
  const candidates = ["Archivo Black", "Anton", "Poppins.*Bold", "Montserrat.*Bold", "Liberation Sans.*Bold"];
  for (const pattern of candidates) {
    try {
      const out = execSync(`fc-list | grep -iE "${pattern}" | head -n1`, { encoding: 'utf8' }).trim();
      if (out) {
        const filePath = out.split(':')[0].trim();
        if (filePath && fs.existsSync(filePath)) return filePath;
      }
    } catch (e) { /* fontconfig غير متوفر، نتابع للخيار التالي */ }
  }
  return BOLD_FONT;
}

function computeClipDurations(imageCount, bpm) {
  const durations = [];
  for (let i = 0; i < imageCount; i++) {
    let d;
    if (i === 0) {
      d = MAX_CLIP_DURATION;
    } else if (i === imageCount - 1) {
      d = MAX_CLIP_DURATION - 0.1;
    } else {
      const wave = (Math.sin(i * 1.7) + 1) / 2;
      d = MIN_CLIP_DURATION + wave * (MAX_CLIP_DURATION - MIN_CLIP_DURATION);
    }
    if (bpm && bpm > 0) {
      const beat = 60 / bpm;
      const beats = Math.max(1, Math.round(d / beat));
      d = Math.min(MAX_CLIP_DURATION, Math.max(MIN_CLIP_DURATION, beats * beat));
    }
    durations.push(Number(d.toFixed(3)));
  }
  return durations;
}

function computeTransitionDurations(imageCount, bpm) {
  const list = [];
  for (let i = 1; i < imageCount; i++) {
    let d = MIN_TRANSITION_DURATION + ((i - 1) % 3) * ((MAX_TRANSITION_DURATION - MIN_TRANSITION_DURATION) / 2);
    if (bpm && bpm > 0) {
      const beat = 60 / bpm;
      d = Math.min(MAX_TRANSITION_DURATION, Math.max(MIN_TRANSITION_DURATION, beat / 2));
    }
    list.push(Number(d.toFixed(3)));
  }
  return list;
}

// ===== حركة كاميرا سينمائية بمنحنيات ناعمة (smoothstep) بدل الحركة الخطية الروبوتية =====
// smoothstep(p) = 3p²-2p³: يبدأ ببطء، يتسارع بالوسط، وينتهي ببطء - إحساس طبيعي بدل خطي جامد.
function smoothstep(p) {
  return `((${p})*(${p})*(3-2*(${p})))`;
}

function easedFrameProgress(N) {
  return smoothstep(`(on/${N})`);
}

// يبني تعابير zoom/x/y لطبقة معينة. القيم مخفّضة عمدًا (بدل زووم قوي) لأن الصورة نفسها
// تعمر الإطار بالكامل بدون هامش أمان (بلا خلفية مموهة) — فأي زووم قوي كان غادي يقصّي
// الشارات اللصيقة بالحواف (FREE, DXF/DWG/SVG, masterdxf.com). هادي حركة خفيفة واضحة
// للعين لكن كافية باش الشارات تبقى ظاهرة أغلب الوقت.
function buildMotion(type, frames, amplitude) {
  const N = Math.max(frames - 1, 1);
  const EASE = easedFrameProgress(N);
  switch (type) {
    case 'zoomIn': {
      const delta = 0.09 * amplitude;
      return { zoom: `1+${delta}*${EASE}`, x: `iw/2-(iw/zoom/2)`, y: `ih/2-(ih/zoom/2)` };
    }
    case 'zoomOut': {
      const delta = 0.08 * amplitude;
      return { zoom: `(1+${delta})-${delta}*${EASE}`, x: `iw/2-(iw/zoom/2)`, y: `ih/2-(ih/zoom/2)` };
    }
    case 'pushLeft': {
      const z = 1 + 0.05 * amplitude;
      return { zoom: `${z}`, x: `(iw-iw/zoom)*(1-${EASE})`, y: `ih/2-(ih/zoom/2)` };
    }
    case 'pushRight': {
      const z = 1 + 0.05 * amplitude;
      return { zoom: `${z}`, x: `(iw-iw/zoom)*${EASE}`, y: `ih/2-(ih/zoom/2)` };
    }
    case 'slowPan':
    default: {
      const z = 1 + 0.035 * amplitude;
      return { zoom: `${z}`, x: `(iw-iw/zoom)*${EASE}`, y: `ih/2-(ih/zoom/2)+((ih-ih/zoom)*${EASE}*0.3)` };
    }
  }
}

// تعبير تلاشي/حركة ناعم بمرور الوقت (يُستخدم للنصوص): يرجع 0..1 بمنحنى smoothstep
// ومُقيَّد تلقائيًا (قبل start=0، بعد start+dur=1) بفضل min/max، فلا حاجة لأقواس if إضافية.
function timeEase(tVar, start, dur) {
  const p = `min(max((${tVar}-(${start}))/(${dur}),0),1)`;
  return smoothstep(p);
}

function buildFilterComplex(imageCount, durations, transitionDurations, totalDuration, hookText, fontFile) {
  const filters = [];
  const motionTypes = ['zoomIn', 'zoomOut', 'pushLeft', 'pushRight', 'slowPan'];

  for (let i = 0; i < imageCount; i++) {
    const frames = Math.round((durations[i] + (transitionDurations[i] || transitionDurations[i - 1] || 0.4)) * FPS);
    const type = motionTypes[i % motionTypes.length];
    const motion = buildMotion(type, frames, 1.0);

    let zoomExpr = motion.zoom;
    if (i === 0) {
      // لقطة افتتاحية قوية، لكن الفريم الأول بالضبط (on=0) لازم يبقى نظيف 100% (يُستعمل غالبًا
      // كـ"كفر/thumbnail" تلقائي من طرف المنصات). لذلك نستعمل نبضة sin: تبدأ من 0 (زووم=1، صورة
      // كاملة نظيفة) وتوصل لأقصى قوتها فمنتصف النبضة ثم ترجع تندمج مع الحركة العادية.
      const punchFrames = Math.max(Math.round(0.22 * FPS), 1);
      zoomExpr = `if(lt(on,${punchFrames}),1+0.32*sin(PI*on/${punchFrames}),${motion.zoom})`;
    }

    filters.push(
      // الصورة الأصلية (بخلفيتها اللي فيها) تعمر الإطار المربع بالكامل مباشرة وبشكل حاد،
      // بلا أي طبقة خلفية مموهة منفصلة — بناءً على طلبك الصريح.
      `[${i}:v]format=rgba,scale=${SUPERSAMPLE}:${SUPERSAMPLE}:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd+full_chroma_int,crop=${SUPERSAMPLE}:${SUPERSAMPLE}[img${i}raw];` +
      `[img${i}raw]zoompan=z='${zoomExpr}':x='${motion.x}':y='${motion.y}':d=${frames}:s=${ZOOMPAN_INTERMEDIATE}x${ZOOMPAN_INTERMEDIATE}:fps=${FPS}[img${i}zp];` +
      `[img${i}zp]scale=${WIDTH}:${HEIGHT}:flags=lanczos+accurate_rnd+full_chroma_int,setsar=1[v${i}]`
    );
  }

  let lastLabel = "v0";
  let cumulativeOffset = durations[0];
  for (let i = 1; i < imageCount; i++) {
    const transitionName = TRANSITIONS[(i - 1) % TRANSITIONS.length];
    const tDur = transitionDurations[i - 1];
    const outLabel = i === imageCount - 1 ? "vfinal" : `vx${i}`;
    filters.push(
      `[${lastLabel}][v${i}]xfade=transition=${transitionName}:duration=${tDur}:offset=${cumulativeOffset.toFixed(3)}[${outLabel}]`
    );
    lastLabel = outLabel;
    cumulativeOffset += durations[i] - tDur;
  }
  if (imageCount === 1) lastLabel = "vfinal", filters[filters.length - 1] = filters[filters.length - 1].replace('[v0]', '[vfinal]');

  // تدرج ألوان احترافي (تباين + تشبع + جاما) مدموج مع تأثير الفلاش الخفيف فنفس الفلتر لتفادي
  // تكرار eq. ملاحظة حرجة محفوظة من قبل: eval=frame إجباري باش تعبير الفلاش الزمني يتحسب فـ كل
  // فريم (eval=init الافتراضي كان يقفل القيمة عند t=0 ويسبب شحوب دائم فالفيديو كامل).
  const flashAlpha = `lt(mod(t,1.1),0.04)*0.15`;
  // فلاش قوي بعد بداية الفيديو مباشرة (إحساس "كليك الكاميرا")، لكن t=0 بالضبط لازم يبقى نظيف
  // 100% بدون أي رفع سطوع (يُستعمل غالبًا كـ"كفر/thumbnail" تلقائي). نبضة sin ترتفع وتنزل
  // بدل ما تبدا فأقصى قوتها.
  const introFlash = `sin(PI*min(t/0.18,1))*0.5`;
  filters.push(
    `[${lastLabel}]eq=contrast=1.06:saturation=1.08:gamma=0.97:brightness='${flashAlpha}+${introFlash}':eval=frame[vgrade]`
  );
  // فينيت خفيف (تعتيم الحواف) لإحساس سينمائي يخلي التصميم فالوسط يبرز أكثر
  filters.push(`[vgrade]vignette=PI/5[vflash]`);

  // الواترمارك: في منتصف الإطار فوق التصميم، شفاف، بدون حدود أو ظل، مع حركة انسيابية بطيئة (drift)
  const wmDriftX = `(w-text_w)/2 + 22*sin(2*PI*t/6)`;
  const wmDriftY = `(h-text_h)/2 + 16*sin(2*PI*t/8+1)`;
  filters.push(
    `[vflash]drawtext=fontfile='${fontFile}':text='${WATERMARK_TEXT}':fontsize=24:fontcolor=white@0.16:` +
    `x='${wmDriftX}':y='${wmDriftY}'[vwm]`
  );

  // الـHook: سطر بسطر (توسيط صحيح لكل سطر) مع حجم خط يتكيف مع طول النص
  const roughLines = wrapLines(hookText || 'FREE DXF DESIGNS', 20);
  let hookFontSize = 64;
  if (roughLines.length === 3) hookFontSize = 56;
  else if (roughLines.length === 4) hookFontSize = 48;
  else if (roughLines.length >= 5) hookFontSize = 40;
  const maxCharsFinal = Math.max(10, Math.floor(920 / (hookFontSize * 0.62)));
  const hookLines = wrapLines(hookText || 'FREE DXF DESIGNS', maxCharsFinal);
  const lineHeight = Math.round(hookFontSize * 1.3);
  const numLines = hookLines.length;

  const hookIn = 0.15;
  const hookOutStart = HOOK_DURATION - 0.45;
  // حركة/تلاشي ناعمين بمنحنى smoothstep بدل الانتقال الخطي الجامد
  const hookEaseIn = timeEase('t', hookIn, 0.25);
  const hookEaseOut = timeEase('t', hookOutStart, HOOK_DURATION - hookOutStart);
  const hookAlpha = `if(lt(t,${hookOutStart}),${hookEaseIn},1-${hookEaseOut})`;
  const hookCenterY = `h*0.5+(h*0.08)*(1-${hookEaseIn})`;

  let lastLabel2 = "vwm";
  hookLines.forEach((line, idx) => {
    const lineFile = path.join(TMP_DIR, `hook_line_${idx}.txt`);
    fs.writeFileSync(lineFile, line);
    const offset = (idx - (numLines - 1) / 2) * lineHeight;
    const outLbl = idx === numLines - 1 ? "vhook" : `vh${idx}`;
    filters.push(
      `[${lastLabel2}]drawtext=fontfile='${fontFile}':textfile='${lineFile}':fontsize=${hookFontSize}:fontcolor=${ACCENT_COLOR}:` +
      `borderw=7:bordercolor=black:shadowcolor=black@0.65:shadowx=5:shadowy=5:` +
      `x=(w-text_w)/2:y='(${hookCenterY})+(${offset.toFixed(2)})-(text_h/2)':` +
      `alpha='${hookAlpha}':enable='lt(t,${HOOK_DURATION})'[${outLbl}]`
    );
    lastLabel2 = outLbl;
  });

  const outroStart = totalDuration - OUTRO_DURATION;
  const midPoint = outroStart + OUTRO_DURATION * 0.5;
  const outroAlpha1 = timeEase('t', outroStart, 0.25);
  const outroAlpha2 = timeEase('t', midPoint, 0.25);
  filters.push(
    `[${lastLabel2}]drawtext=fontfile='${fontFile}':textfile='${OUTRO_FILE_1}':fontsize=56:fontcolor=white:` +
    `borderw=6:bordercolor=black:shadowcolor=black@0.6:shadowx=4:shadowy=4:` +
    `x=(w-text_w)/2:y=(h-text_h)/2-60:alpha='${outroAlpha1}'[vout1]`
  );
  filters.push(
    `[vout1]drawtext=fontfile='${fontFile}':textfile='${OUTRO_FILE_2}':fontsize=52:fontcolor=${ACCENT_COLOR}:` +
    `borderw=6:bordercolor=black:shadowcolor=black@0.6:shadowx=4:shadowy=4:` +
    `x=(w-text_w)/2:y=(h-text_h)/2+30:alpha='${outroAlpha2}'[voutraw]`
  );

  // تحويل صريح ودقيق من RGB (full range) إلى YUV420p (limited range, BT.709) باستعمال zscale.
  // ملاحظة: zscale (مكتبة zimg) قد يفشل بخطأ "no path between colorspaces" إذا كانت الصورة
  // لا تزال بصيغة rgba (فيها قناة alpha)، لذلك نحوّلها إلى rgb24 أولاً.
  filters.push(`[voutraw]format=rgb24,zscale=matrix=709:range=limited,format=yuv420p[vout]`);

  return filters.join(";\n");
}

async function main() {
  const data = JSON.parse(fs.readFileSync('data/latest-output.json', 'utf8'));
  const { images, music_url, hook_text, bpm } = data;

  if (!images || images.length === 0) throw new Error('لا توجد صور بـ latest-output.json');

  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(OUTRO_FILE_1, wrapText('FREE DXF FILES', 22));
  fs.writeFileSync(OUTRO_FILE_2, wrapText('MasterDXF.com', 22));

  const localImages = [];
  for (let i = 0; i < images.length; i++) {
    const urlExt = path.extname(new URL(images[i]).pathname) || '.jpg';
    const dest = path.join(TMP_DIR, `img${i}${urlExt}`);
    await downloadFile(images[i], dest);
    localImages.push(dest);
    console.log(`✅ تم تحميل الصورة ${i + 1}/${images.length}`);
  }
  const localMusic = path.join(TMP_DIR, 'music.mp3');
  await downloadFile(music_url, localMusic);
  console.log('✅ تم تحميل الموسيقى');

  const fontFile = pickFont();
  const durations = computeClipDurations(localImages.length, bpm);
  const transitionDurations = computeTransitionDurations(localImages.length, bpm);
  const totalDuration = durations.reduce((a, b) => a + b, 0) - transitionDurations.reduce((a, b) => a + b, 0);

  const filterComplex = buildFilterComplex(localImages.length, durations, transitionDurations, totalDuration, hook_text, fontFile);
  const imageInputs = localImages.map(f => `-loop 1 -i "${f}"`).join(' ');
  const outputPath = 'data/latest-video.mp4';
  const safetyDuration = (totalDuration + 0.3).toFixed(2);

  const cmd = [
    'ffmpeg -y',
    '-sws_flags lanczos+accurate_rnd+full_chroma_int',
    imageInputs,
    `-i "${localMusic}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[vout]"`,
    `-map ${localImages.length}:a`,
    `-af "volume=0.8"`,
    `-t ${safetyDuration}`,
    `-c:v libx264 -profile:v high -preset slow -crf 20 -pix_fmt yuv420p`,
    `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`,
    `-c:a aac -b:a 192k -movflags +faststart`,
    `"${outputPath}"`
  ].join(' ');

  console.log('🎬 جارِ بناء الفيديو الاحترافي...');
  execSync(cmd, { stdio: 'inherit' });
  console.log(`✅ تم إنشاء الفيديو: ${outputPath}`);

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

main().catch(err => {
  console.error('❌ خطأ:', err.message);
  process.exit(1);
});
