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
const MIN_TRANSITION_DURATION = 0.3;
const MAX_TRANSITION_DURATION = 0.5;
const WATERMARK_TEXT = "MasterDXF.com";
const ACCENT_COLOR = "0xFFC107"; // أصفر/برتقالي لافت للكلمات المهمة (FREE, MasterDXF.com)
const FOREGROUND_FRACTION = 0.74; // نسبة مساحة التصميم من الإطار حتى يبقى كاملاً وغير مقصوص أثناء الزووم
const TRANSITIONS = ["zoomin", "circleopen", "radial", "distance", "smoothleft", "smoothright", "hblur", "dissolve", "wiperight", "wipeleft", "diagtl", "diagbr"];
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

// ===== الجزء الجديد =====

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

function getMotionExpr(index, frames) {
  const types = ['zoomIn', 'zoomOut', 'pushLeft', 'pushRight', 'pushUp', 'pushDown', 'diagonal', 'slowPan', 'fastPush', 'dynamicZoom'];
  const type = types[index % types.length];
  const N = Math.max(frames - 1, 1);
  switch (type) {
    case 'zoomIn':
      return { zoom: `min(zoom+0.0018,1.22)`, x: `iw/2-(iw/zoom/2)`, y: `ih/2-(ih/zoom/2)` };
    case 'zoomOut':
      return { zoom: `if(eq(on,0),1.22,max(zoom-0.0018,1.0))`, x: `iw/2-(iw/zoom/2)`, y: `ih/2-(ih/zoom/2)` };
    case 'pushLeft':
      return { zoom: `1.12`, x: `(iw-iw/zoom)*(1-on/${N})`, y: `ih/2-(ih/zoom/2)` };
    case 'pushRight':
      return { zoom: `1.12`, x: `(iw-iw/zoom)*(on/${N})`, y: `ih/2-(ih/zoom/2)` };
    case 'pushUp':
      return { zoom: `1.12`, x: `iw/2-(iw/zoom/2)`, y: `(ih-ih/zoom)*(1-on/${N})` };
    case 'pushDown':
      return { zoom: `1.12`, x: `iw/2-(iw/zoom/2)`, y: `(ih-ih/zoom)*(on/${N})` };
    case 'diagonal':
      return { zoom: `1.14`, x: `(iw-iw/zoom)*(on/${N})`, y: `(ih-ih/zoom)*(on/${N})` };
    case 'slowPan':
      return { zoom: `1.06`, x: `(iw-iw/zoom)*(on/${N})`, y: `ih/2-(ih/zoom/2)` };
    case 'fastPush':
      return { zoom: `min(zoom+0.0045,1.28)`, x: `iw/2-(iw/zoom/2)`, y: `ih/2-(ih/zoom/2)` };
    case 'dynamicZoom':
    default:
      return { zoom: `if(lt(on,${Math.round(N * 0.35)}),min(zoom+0.007,1.25),min(zoom+0.0008,1.3))`, x: `iw/2-(iw/zoom/2)`, y: `ih/2-(ih/zoom/2)` };
  }
}

function buildFilterComplex(imageCount, durations, transitionDurations, totalDuration, hookText, fontFile) {
  const filters = [];
  const SS_FG = evenRound(SUPERSAMPLE * FOREGROUND_FRACTION);

  // لكل صورة: خلفية مموّهة تملأ الإطار بالكامل (بدون تعتيم) + التصميم كاملاً بدون أي قص في المقدمة، ثم حركة الكاميرا
  for (let i = 0; i < imageCount; i++) {
    const frames = Math.round((durations[i] + (transitionDurations[i] || transitionDurations[i - 1] || 0.4)) * FPS);
    const motion = getMotionExpr(i, frames);
    let zoomExpr = motion.zoom;
    if (i === 0) {
      const punchFrames = Math.round(0.2 * FPS);
      zoomExpr = `if(lt(on,${punchFrames}),1+0.35*(on/${punchFrames}),${motion.zoom})`;
    }
    filters.push(
      `[${i}:v]split=2[bg${i}s][fg${i}s];` +
      `[bg${i}s]scale=${SUPERSAMPLE}:${SUPERSAMPLE}:force_original_aspect_ratio=increase,crop=${SUPERSAMPLE}:${SUPERSAMPLE},gblur=sigma=30[bg${i}];` +
      `[fg${i}s]scale=${SS_FG}:${SS_FG}:force_original_aspect_ratio=decrease:flags=lanczos[fg${i}];` +
      `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2[comp${i}];` +
      `[comp${i}]zoompan=z='${zoomExpr}':x='${motion.x}':y='${motion.y}':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},setsar=1[v${i}]`
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

  const flashAlpha = `lt(mod(t,1.1),0.04)*0.15`;
  filters.push(`[${lastLabel}]eq=brightness='${flashAlpha}'[vflash]`);

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
  const hookAlpha = `if(lt(t,${hookIn}),0,if(lt(t,${hookIn + 0.25}),(t-${hookIn})/0.25,if(lt(t,${hookOutStart}),1,if(lt(t,${HOOK_DURATION}),(${HOOK_DURATION}-t)/0.45,0))))`;
  const hookCenterY = `if(lt(t,${hookIn + 0.25}),(h*0.58)-((h*0.58)-(h*0.5))*((t-${hookIn})/0.25),h*0.5)`;

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
  const outroAlpha1 = `if(lt(t,${outroStart}),0,if(lt(t,${outroStart + 0.2}),(t-${outroStart})/0.2,if(lt(t,${midPoint}),1,0)))`;
  const outroAlpha2 = `if(lt(t,${midPoint}),0,if(lt(t,${midPoint + 0.2}),(t-${midPoint})/0.2,if(lt(t,${totalDuration}),1,0)))`;
  filters.push(
    `[${lastLabel2}]drawtext=fontfile='${fontFile}':textfile='${OUTRO_FILE_1}':fontsize=56:fontcolor=white:` +
    `borderw=6:bordercolor=black:shadowcolor=black@0.6:shadowx=4:shadowy=4:` +
    `x=(w-text_w)/2:y=(h-text_h)/2-60:alpha='${outroAlpha1}'[vout1]`
  );
  filters.push(
    `[vout1]drawtext=fontfile='${fontFile}':textfile='${OUTRO_FILE_2}':fontsize=52:fontcolor=${ACCENT_COLOR}:` +
    `borderw=6:bordercolor=black:shadowcolor=black@0.6:shadowx=4:shadowy=4:` +
    `x=(w-text_w)/2:y=(h-text_h)/2+30:alpha='${outroAlpha2}'[vout]`
  );

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

  // Two-Pass Encoding بهدف بترات ثابت (6 Mbps) — آمن تحت سقف TikTok API (10 Mbps)،
  // وممتاز لـ Instagram/Facebook، مع أعلى جودة ممكنة ضمن هذا الحجم المحدد مسبقًا
  // البترات يُحسب ديناميكيًا حسب مدة كل فيديو، بحيث الحجم النهائي يستهدف ≈ 6MB بالضبط
  const passLogFile = path.join(TMP_DIR, 'ffmpeg2pass');
  const TARGET_SIZE_MB = 7.5; // محسوبة: 512MB شهريًا ÷ 60 فيديو = 8.53MB نظريًا، مع هامش أمان لباقي عمليات Make
  const AUDIO_BITRATE_KBPS = 128; // مخفّض من 192 لترك مساحة أكبر لجودة الصورة ضمن سقف 6MB
  const durationSec = parseFloat(safetyDuration);
  const targetTotalBits = TARGET_SIZE_MB * 8 * 1024 * 1024 * 0.97; // هامش أمان 3% لحاوية MP4
  const audioBits = AUDIO_BITRATE_KBPS * 1000 * durationSec;
  const videoKbps = Math.max(300, Math.round((targetTotalBits - audioBits) / durationSec / 1000));
  const TARGET_BITRATE = `${videoKbps}k`;
  const MAX_BITRATE = `${Math.round(videoKbps * 1.15)}k`;
  const BUF_SIZE = `${Math.round(videoKbps * 2)}k`;
  console.log(`ℹ️ مدة الفيديو: ${durationSec}s → بترات فيديو مستهدف: ${videoKbps} kbps (لتحقيق ≈${TARGET_SIZE_MB}MB)`);

  const commonVideoArgs = [
    'ffmpeg -y',
    imageInputs,
    `-i "${localMusic}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[vout]"`,
    `-t ${safetyDuration}`,
    `-c:v libx264 -profile:v high -preset medium -tune animation -x264-params "aq-mode=3"`,
    `-b:v ${TARGET_BITRATE} -maxrate ${MAX_BITRATE} -bufsize ${BUF_SIZE} -pix_fmt yuv420p`
  ].join(' ');

  const pass1Cmd = `${commonVideoArgs} -an -pass 1 -passlogfile "${passLogFile}" -f null /dev/null`;
  const pass2Cmd = `${commonVideoArgs} -map ${localImages.length}:a -af "volume=0.8" -pass 2 -passlogfile "${passLogFile}" -c:a aac -b:a ${AUDIO_BITRATE_KBPS}k -movflags +faststart "${outputPath}"`;

  console.log('🎬 المرحلة 1/2: تحليل الفيديو (Pass 1)...');
  execSync(pass1Cmd, { stdio: 'inherit' });
  console.log('🎬 المرحلة 2/2: بناء الفيديو النهائي (Pass 2)...');
  execSync(pass2Cmd, { stdio: 'inherit' });
  console.log(`✅ تم إنشاء الفيديو: ${outputPath}`);

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

main().catch(err => {
  console.error('❌ خطأ:', err.message);
  process.exit(1);
});
