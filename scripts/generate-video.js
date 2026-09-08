const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const WIDTH = 1080;
const HEIGHT = 1080;
const SUPERSAMPLE = WIDTH * 3;
const FPS = 30;
const MIN_CLIP_DURATION = 1.4;
const MAX_CLIP_DURATION = 2.3;
const MIN_TRANSITION_DURATION = 0.3;
const MAX_TRANSITION_DURATION = 0.5;
const WATERMARK_TEXT = "MasterDXF.com";
const TRANSITIONS = ["zoomin", "circleopen", "radial", "distance", "smoothleft", "smoothright", "hblur", "dissolve", "wiperight", "wipeleft", "diagtl", "diagbr"];
const HOOK_DURATION = 2.4;
const OUTRO_DURATION = 1.8;
const BOLD_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const TMP_DIR = "tmp_video_build";
const HOOK_FILE = path.join(TMP_DIR, "hook_text.txt");
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

// ===== الجزء الجديد: منطق الحركة والانتقالات الاحترافية =====

// يحسب مدة ديناميكية لكل صورة: أول صورة وآخر صورة أطول قليلاً (أهم لحظات الفيديو)
function computeClipDurations(imageCount, bpm) {
  const durations = [];
  for (let i = 0; i < imageCount; i++) {
    let d;
    if (i === 0) {
      d = MAX_CLIP_DURATION; // أقوى تصميم في البداية يأخذ وقته
    } else if (i === imageCount - 1) {
      d = MAX_CLIP_DURATION - 0.1; // آخر تصميم قبل الـCTA
    } else {
      // تصاعد بصري خفيف: نتحرك بين الحد الأدنى والأقصى بموجة ناعمة بدل العشوائية الكاملة
      const wave = (Math.sin(i * 1.7) + 1) / 2; // 0..1
      d = MIN_CLIP_DURATION + wave * (MAX_CLIP_DURATION - MIN_CLIP_DURATION);
    }
    // إذا توفر bpm في latest-output.json، نقرّب المدة لأقرب مضاعف لضربة الموسيقى (Beat Sync تقريبي)
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

// حركة كاميرا مختلفة لكل صورة بدل نفس الزووم للجميع
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

function buildFilterComplex(imageCount, durations, transitionDurations, totalDuration) {
  const filters = [];

  // أول صورة تبدأ بـ Push-in سريع جدًا (0.1-0.3s) قبل أن تدخل حركتها العادية
  for (let i = 0; i < imageCount; i++) {
    const frames = Math.round((durations[i] + (transitionDurations[i] || transitionDurations[i - 1] || 0.4)) * FPS);
    const motion = getMotionExpr(i, frames);
    let zoomExpr = motion.zoom;
    if (i === 0) {
      // Punch-in فوري في أول 0.2 ثانية فقط ثم استكمال الحركة العادية
      const punchFrames = Math.round(0.2 * FPS);
      zoomExpr = `if(lt(on,${punchFrames}),1+0.35*(on/${punchFrames}),${motion.zoom})`;
    }
    filters.push(
      `[${i}:v]scale=${SUPERSAMPLE}:${SUPERSAMPLE}:force_original_aspect_ratio=increase,crop=${SUPERSAMPLE}:${SUPERSAMPLE},` +
      `zoompan=z='${zoomExpr}':x='${motion.x}':y='${motion.y}':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
      `setsar=1[v${i}]`
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
  // في حال صورة واحدة فقط
  if (imageCount === 1) lastLabel = "vfinal", filters[filters.length - 1] = filters[filters.length - 1].replace('[v0]', '[vfinal]');

  // Light flash خفيف عند كل انتقال تقريبًا (إحساس بضربة الموسيقى)
  const flashAlpha = `lt(mod(t,1.1),0.04)*0.15`;
  filters.push(
    `[${lastLabel}]eq=brightness='${flashAlpha}'[vflash]`
  );

  // الواترمارك: صغير، ثابت، في الزاوية السفلية اليمنى، لا يغطي التصميم
  filters.push(
    `[vflash]drawtext=fontfile='${BOLD_FONT}':text='${WATERMARK_TEXT}':fontsize=26:fontcolor=white@0.9:` +
    `borderw=2:bordercolor=black@0.6:` +
    `box=1:boxcolor=black@0.45:boxborderw=8:` +
    `x=w-text_w-28:y=h-th-28[vwm]`
  );

  // الـHook: يظهر بعد التصميم مباشرة (0.15s)، دخول Fade+Slide سريع، خروج سريع قبل نهاية HOOK_DURATION
  const hookIn = 0.15, hookHold = HOOK_DURATION - 0.6, hookOutStart = HOOK_DURATION - 0.45;
  const hookAlpha = `if(lt(t,${hookIn}),0,if(lt(t,${hookIn + 0.25}),(t-${hookIn})/0.25,if(lt(t,${hookOutStart}),1,if(lt(t,${HOOK_DURATION}),(${HOOK_DURATION}-t)/0.45,0))))`;
  const hookY = `if(lt(t,${hookIn + 0.25}),(h*0.58)-((h*0.58)-(h-th)/2)*((t-${hookIn})/0.25),(h-th)/2)`;
  filters.push(
    `[vwm]drawtext=fontfile='${BOLD_FONT}':textfile='${HOOK_FILE}':fontsize=58:fontcolor=white:` +
    `borderw=4:bordercolor=black:` +
    `box=1:boxcolor=black@0.78:boxborderw=22:line_spacing=12:` +
    `x=(w-text_w)/2:y='${hookY}':` +
    `alpha='${hookAlpha}':enable='lt(t,${HOOK_DURATION})'[vhook]`
  );

  // الـOutro (آخر 1.8s): "FREE DXF FILES" ثم "MasterDXF.com"، مع Zoom بسيط (متكفّل به آخر motion أصلاً)
  const outroStart = totalDuration - OUTRO_DURATION;
  const midPoint = outroStart + OUTRO_DURATION * 0.5;
  const outroAlpha1 = `if(lt(t,${outroStart}),0,if(lt(t,${outroStart + 0.2}),(t-${outroStart})/0.2,if(lt(t,${midPoint}),1,0)))`;
  const outroAlpha2 = `if(lt(t,${midPoint}),0,if(lt(t,${midPoint + 0.2}),(t-${midPoint})/0.2,if(lt(t,${totalDuration}),1,0)))`;
  filters.push(
    `[vhook]drawtext=fontfile='${BOLD_FONT}':textfile='${OUTRO_FILE_1}':fontsize=54:fontcolor=white:` +
    `borderw=4:bordercolor=black:box=1:boxcolor=black@0.8:boxborderw=20:` +
    `x=(w-text_w)/2:y=(h-text_h)/2-60:alpha='${outroAlpha1}'[vout1]`
  );
  filters.push(
    `[vout1]drawtext=fontfile='${BOLD_FONT}':textfile='${OUTRO_FILE_2}':fontsize=50:fontcolor=white:` +
    `borderw=4:bordercolor=black:box=1:boxcolor=black@0.8:boxborderw=20:` +
    `x=(w-text_w)/2:y=(h-text_h)/2+30:alpha='${outroAlpha2}'[vout]`
  );

  return filters.join(";\n");
}

async function main() {
  const data = JSON.parse(fs.readFileSync('data/latest-output.json', 'utf8'));
  const { images, music_url, hook_text, bpm } = data;

  if (!images || images.length === 0) throw new Error('لا توجد صور بـ latest-output.json');

  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(HOOK_FILE, wrapText(hook_text || 'FREE DXF DESIGNS 🔥', 22));
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

  const durations = computeClipDurations(localImages.length, bpm);
  const transitionDurations = computeTransitionDurations(localImages.length, bpm);
  const totalDuration = durations.reduce((a, b) => a + b, 0) - transitionDurations.reduce((a, b) => a + b, 0);

  const filterComplex = buildFilterComplex(localImages.length, durations, transitionDurations, totalDuration);
  const imageInputs = localImages.map(f => `-loop 1 -i "${f}"`).join(' ');
  const outputPath = 'data/latest-video.mp4';
  const safetyDuration = (totalDuration + 0.3).toFixed(2);

  const cmd = [
    'ffmpeg -y',
    imageInputs,
    `-i "${localMusic}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[vout]"`,
    `-map ${localImages.length}:a`,
    `-af "volume=0.8"`,
    `-t ${safetyDuration}`,
    `-c:v libx264 -profile:v high -preset slow -crf 16 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart`,
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
