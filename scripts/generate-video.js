const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const WIDTH = 1080;
const HEIGHT = 1080;
const SUPERSAMPLE = WIDTH * 3;
const FPS = 30;
// [تعديل] بدل مدة مقطع ثابتة تقريبًا لكل الفيديوهات، دابا نستهدف مدة إجمالية عشوائية
// للفيديو كامل بين 10 و18 ثانية، وتُقسّم على عدد الصور المرفوعة (مهما كان عددها) — فكل
// الصور تظهر إجباريًا، ومدة كل مقطع تُحسب ديناميكيًا حسب العدد والمدة المستهدفة.
const TARGET_TOTAL_MIN = 10;
const TARGET_TOTAL_MAX = 18;
// حد أدنى آمن لمدة أي مقطع حتى لا يصبح "ومضة" غير مفهومة إذا كان عدد الصور كبيرًا جدًا
// مقارنة بالمدة المستهدفة (عندها المدة الإجمالية قد تتجاوز 18s قليلاً لضمان وضوح كل صورة،
// وهذا أفضل من حذف صور أو عرضها بسرعة غير مفهومة).
const MIN_SAFE_CLIP_DURATION = 1.1;
const MIN_TRANSITION_DURATION = 0.55;
const MAX_TRANSITION_DURATION = 0.85;
const WATERMARK_TEXT = "MasterDXF.com";

// ===== [تعديل] مجموعات ألوان عشوائية بدل لون ثابت — تُختار مرة واحدة لكل فيديو =====
const ACCENT_PALETTE = ["0xFFC107", "0xFF7043", "0xFFEB3B", "0xFF5252", "0xFFA726"];
const FOLLOW_PALETTE = ["0x00E676", "0x1DE9B6", "0x64DD17", "0x00E5FF"];
const ACCENT_COLOR = ACCENT_PALETTE[Math.floor(Math.random() * ACCENT_PALETTE.length)];
const FOLLOW_COLOR = FOLLOW_PALETTE[Math.floor(Math.random() * FOLLOW_PALETTE.length)];

// zoompan يستعمل خوارزمية تصغير داخلية ضعيفة الجودة ولا يقبل flags=lanczos إطلاقًا.
// لذلك نخليه يخرج بحجم وسيط (2x الحجم النهائي) بدل الحجم النهائي مباشرة، ثم فلتر scale منفصل
// بـ lanczos بعده يدير التصغير الحقيقي عالي الجودة.
const ZOOMPAN_INTERMEDIATE = WIDTH * 2;
// مجموعة أوسع من الانتقالات المميزة بصريًا عن بعضها (8 بدل 4) — تُخلط عشوائيًا في كل فيديو
// وتُوزّع بلا أي تكرار (طالما عدد الانتقالات المطلوبة ≤ 8)، فلا يظهر نفس الانتقال مرتين.
const TRANSITIONS = ["zoomin", "circleopen", "hblur", "smoothleft", "radial", "distance", "wiperight", "diagtr"];
const HOOK_DURATION = 2.4;
const OUTRO_DURATION = 2.3; // زيدت من 1.8 لإفساح وقت كافٍ لظهور سطر ثالث ("تابعونا") بتتابع مريح
const BOLD_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"; // fallback افتراضي
const TMP_DIR = "tmp_video_build";
const OUTRO_FILE_1 = path.join(TMP_DIR, "outro_text_1.txt");
const OUTRO_FILE_2 = path.join(TMP_DIR, "outro_text_2.txt");

// ===== إعدادات تأثير الدوامة الحقيقية (Vortex/Swirl) على الصورة الأولى (دخول الفيديو) =====
// [تعديل] قوة ومدة الدوامة تُصادف عشوائيًا في نطاق ضيق لكل فيديو (بدل قيمة ثابتة دائمًا)
// باش البصمة البصرية للقطة الافتتاحية تختلف بين نسخة وأخرى.
const SPIN_DURATION = Number((0.7 + Math.random() * 0.4).toFixed(3));   // بين 0.7 و1.1 ثانية
// [تعديل] نطاق أوسع لقوة الدوامة (4 إلى 10 بدل 5 إلى 8) + اتجاه عشوائي (مع/عكس عقارب الساعة)
// عبر إشارة عشوائية — يضاعف عدد التركيبات البصرية الممكنة للقطة الافتتاحية.
const SWIRL_DIRECTION = Math.random() < 0.5 ? 1 : -1;
const SWIRL_STRENGTH_MAX = Number((4 + Math.random() * 6).toFixed(3)) * SWIRL_DIRECTION; // بين 4 و10 راديان، باتجاه عشوائي

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

// [تعديل جوهري] بدل مدة مقطع شبه ثابتة، نحسب الآن مدة كل مقطع ديناميكيًا:
// 1) نختار مدة إجمالية عشوائية للفيديو كامل بين TARGET_TOTAL_MIN و TARGET_TOTAL_MAX.
// 2) نوزّعها بالتساوي على عدد الصور (imageCount) مع مراعاة زمن الانتقالات (transitions)
//    التي "تُقتطع" من المدة الإجمالية حسب منطق xfade الأصلي (offset تراكمي).
// 3) نضيف تموّجًا عضويًا (نفس فكرة الموجة الأصلية sin) لكل مقطع بدل مدة متساوية جامدة.
// 4) نعيد قياس (rescale) النتيجة النهائية باش تصل المدة الإجمالية الحقيقية لنفس الهدف
//    بالضبط (تعويض أي انحراف بسيط سببه التقريب أو الحد الأدنى الآمن للمقطع).
function computeClipDurations(imageCount, bpm, transitionDurations) {
  const targetTotal = TARGET_TOTAL_MIN + Math.random() * (TARGET_TOTAL_MAX - TARGET_TOTAL_MIN);
  const transitionsSum = transitionDurations.reduce((a, b) => a + b, 0);
  // مجموع مدد المقاطع (durations) اللازم كي تصبح المدة الإجمالية (بعد طرح زمن التداخل
  // الناتج عن xfade) مساوية بالضبط لـ targetTotal — نفس معادلة totalDuration الأصلية معكوسة.
  const sumDurationsNeeded = targetTotal + transitionsSum;
  const baseClip = sumDurationsNeeded / imageCount;

  // تموّج عضوي حول القيمة الأساسية (± حتى 18% منها) بدل مدة متساوية جامدة لكل مقطع.
  const rawDurations = [];
  for (let i = 0; i < imageCount; i++) {
    const wave = Math.sin(i * 1.7); // -1..1
    let d = baseClip * (1 + wave * 0.18);
    d = Math.max(d, MIN_SAFE_CLIP_DURATION); // حد أدنى آمن حتى لا تصبح "ومضة"
    rawDurations.push(d);
  }

  // إعادة القياس (rescale) لضمان وصول المدة الإجمالية الحقيقية لنفس الهدف بالضبط، إلا إذا
  // فرض MIN_SAFE_CLIP_DURATION حدًا أعلى من targetTotal (عدد صور كبير جدًا) — عندها نترك
  // المدة الإجمالية تتجاوز 18s قليلاً بدل التضحية بوضوح أي صورة.
  const rawSum = rawDurations.reduce((a, b) => a + b, 0);
  const scale = sumDurationsNeeded / rawSum;
  let durations = rawDurations.map(d => d * scale);
  // بعد القياس قد ينزل مقطع تحت الحد الآمن من جديد بسبب scale<1 — نصلح ذلك بتثبيت الحد
  // الأدنى ثم توزيع الفارق على باقي المقاطع (تعويض بسيط) بدل كسر الوعد بالمدة الإجمالية.
  let deficit = 0;
  durations = durations.map(d => {
    if (d < MIN_SAFE_CLIP_DURATION) { deficit += MIN_SAFE_CLIP_DURATION - d; return MIN_SAFE_CLIP_DURATION; }
    return d;
  });
  if (deficit > 0) {
    const flexibleIdx = durations.map((d, i) => i).filter(i => durations[i] > MIN_SAFE_CLIP_DURATION);
    if (flexibleIdx.length > 0) {
      const cut = deficit / flexibleIdx.length;
      flexibleIdx.forEach(i => { durations[i] = Math.max(MIN_SAFE_CLIP_DURATION, durations[i] - cut); });
    }
  }

  return durations.map(d => Number(d.toFixed(3)));
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

// [تعديل] اختيار نوع الحركة عشوائيًا لكل مقطع (بدل التوزيع الثابت i % motionTypes.length)،
// مع تفادي تكرار نفس الحركة مرتين متتاليتين حتى يبقى التنوع البصري ملموسًا.
function pickMotionSequence(count) {
  const types = ['zoomIn', 'zoomOut', 'pushLeft', 'pushRight', 'slowPan'];
  const seq = [];
  let last = null;
  for (let i = 0; i < count; i++) {
    let choice;
    do { choice = types[Math.floor(Math.random() * types.length)]; }
    while (choice === last && types.length > 1);
    seq.push(choice);
    last = choice;
  }
  return seq;
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
      const delta = 0.12 * amplitude;
      return { zoom: `1+${delta}*${EASE}`, x: `iw/2-(iw/zoom/2)`, y: `ih/2-(ih/zoom/2)` };
    }
    case 'zoomOut': {
      const delta = 0.11 * amplitude;
      return { zoom: `(1+${delta})-${delta}*${EASE}`, x: `iw/2-(iw/zoom/2)`, y: `ih/2-(ih/zoom/2)` };
    }
    case 'pushLeft': {
      const z = 1 + 0.10 * amplitude;
      return { zoom: `${z}`, x: `(iw-iw/zoom)*(1-${EASE})`, y: `ih/2-(ih/zoom/2)` };
    }
    case 'pushRight': {
      const z = 1 + 0.10 * amplitude;
      return { zoom: `${z}`, x: `(iw-iw/zoom)*${EASE}`, y: `ih/2-(ih/zoom/2)` };
    }
    case 'slowPan':
    default: {
      const z = 1 + 0.08 * amplitude;
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

  // [تعديل] "مزاج" عام يُحدَّد مرة واحدة لكل فيديو كامل (وليس لكل مقطع على حدة) — يضاعف كل
  // شدات الحركة بمعامل موحّد، فبعض الفيديوهات تطلع أهدى بشكل عام وبعضها أقوى بشكل عام،
  // فوق التنوع الموجود أصلاً لكل مقطع على حدة. هذا يضمن اختلاف واضح "بالعين المجردة" حتى لو
  // صدفة طلع نفس ترتيب أنواع الحركة في فيديوهين مختلفين.
  const GLOBAL_ENERGY = Number((0.85 + Math.random() * 0.6).toFixed(3)); // بين 0.85 و1.45

  // [تعديل] تسلسل حركة عشوائي لكل فيديو (بدل motionTypes[i % motionTypes.length] الثابت)
  const motionSequence = pickMotionSequence(imageCount);

  // خلط عشوائي لمجموعة الانتقالات مرة واحدة لكل فيديو، ثم توزيعها بالترتيب بلا تكرار
  // (طالما عدد الانتقالات المطلوبة ≤ طول القائمة). إذا احتجنا أكثر من الطول، نعيد الخلط
  // لدورة جديدة بدل التدوير الثابت بـ % الذي كان يكرر نفس الترتيب في كل فيديو.
  function shuffledTransitions(count) {
    const result = [];
    while (result.length < count) {
      const pool = [...TRANSITIONS];
      for (let k = pool.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [pool[k], pool[j]] = [pool[j], pool[k]];
      }
      result.push(...pool);
    }
    return result.slice(0, count);
  }
  const transitionOrder = shuffledTransitions(Math.max(imageCount - 1, 0));

  for (let i = 0; i < imageCount; i++) {
    const frames = Math.round((durations[i] + (transitionDurations[i] || transitionDurations[i - 1] || 0.4)) * FPS);
    const type = motionSequence[i];
    // [تعديل] شدة الزووم/الحركة (amplitude) عشوائية لكل مقطع، مضروبة بمعامل الطاقة العام
    // للفيديو كامل (GLOBAL_ENERGY) — طبقتان من العشوائية: لكل مقطع + لكل فيديو ككل.
    const amplitude = Number((0.75 + Math.random() * 0.85).toFixed(3)) * GLOBAL_ENERGY;
    const motion = buildMotion(type, frames, amplitude);

    let zoomExpr = motion.zoom;
    if (i === 0) {
      // لقطة افتتاحية قوية، لكن الفريم الأول بالضبط (on=0) لازم يبقى نظيف 100% (يُستعمل غالبًا
      // كـ"كفر/thumbnail" تلقائي من طرف المنصات). لذلك نستعمل نبضة sin: تبدأ من 0 (زووم=1، صورة
      // كاملة نظيفة) وتوصل لأقصى قوتها فمنتصف النبضة ثم ترجع تندمج مع الحركة العادية.
      // [تعديل] قوة ومدة النبضة عشوائيتان لكل فيديو (بدل 0.32 و0.22s ثابتتين) — دخول "أقوى"
      // ومتنوع في كل مرة. الأمان محفوظ رياضيًا: sin(PI*on/punchFrames) = 0 بالضبط عند on=0
      // مهما كانت قوة النبضة (punchStrength)، فالفريم الأول يبقى نظيفًا 100% دائمًا.
      const punchStrength = (0.28 + Math.random() * 0.22).toFixed(3); // بين 0.28 و0.5
      const punchSeconds = 0.16 + Math.random() * 0.14;               // بين 0.16 و0.30 ثانية
      const punchFrames = Math.max(Math.round(punchSeconds * FPS), 1);
      zoomExpr = `if(lt(on,${punchFrames}),1+${punchStrength}*sin(PI*on/${punchFrames}),${motion.zoom})`;
    }

    filters.push(
      // الصورة الأصلية (بخلفيتها اللي فيها) تعمر الإطار المربع بالكامل مباشرة وبشكل حاد،
      // بلا أي طبقة خلفية مموهة منفصلة — بناءً على طلبك الصريح.
      `[${i}:v]format=rgba,scale=${SUPERSAMPLE}:${SUPERSAMPLE}:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd+full_chroma_int,crop=${SUPERSAMPLE}:${SUPERSAMPLE}[img${i}raw];` +
      `[img${i}raw]zoompan=z='${zoomExpr}':x='${motion.x}':y='${motion.y}':d=${frames}:s=${ZOOMPAN_INTERMEDIATE}x${ZOOMPAN_INTERMEDIATE}:fps=${FPS}[img${i}zp]`
    );

    if (i === 0) {
      // ===== دوامة حقيقية (Vortex/Swirl) على الصورة الأولى فقط =====
      // القوة (T=الزمن بالثواني) تبدأ من صفر تمامًا عند t=0 (فريم نظيف)، ترتفع بمنحنى sin
      // لذروتها في منتصف SPIN_DURATION، ثم تعود لصفر تمامًا عند نهايتها — فلا حاجة لأي محاذاة
      // أو حيلة تكبير، والصورة تعود لوضعها الطبيعي 100% تلقائيًا بعد انتهاء المدة.
      const swirlHump = `sin(PI*min(T/${SPIN_DURATION},1))`;
      const cx = `((W-1)/2)`;
      const cy = `((H-1)/2)`;
      const rExpr = `hypot(X-${cx},Y-${cy})`;
      const rmax = `(min(W,H)/2)`;
      // fac يخفت من 1 بالمركز إلى 0 عند محيط الدائرة المحاطة بالمربع — يضمن بقاء نقطة العيّنة
      // دائمًا ضمن حدود الصورة (بما أن نصف القطر R لا يتغير، فقط الزاوية) مهما كانت شدة الالتفاف.
      const fac = `max(0,1-${rExpr}/${rmax})`;
      const theta = `(atan2(Y-${cy},X-${cx})+${SWIRL_STRENGTH_MAX}*${swirlHump}*${fac})`;
      const sx = `(${cx}+${rExpr}*cos(${theta}))`;
      const sy = `(${cy}+${rExpr}*sin(${theta}))`;
      const swirlExpr = `p(${sx},${sy})`;

      filters.push(
        `[img0zp]scale=${WIDTH}:${HEIGHT}:flags=lanczos+accurate_rnd+full_chroma_int,setsar=1,format=rgb24[v0rgb];` +
        `[v0rgb]geq=r='${swirlExpr}':g='${swirlExpr}':b='${swirlExpr}':interpolation=bilinear:enable='lt(t\\,${SPIN_DURATION})',format=rgba[v0]`
      );
    } else {
      filters.push(
        `[img${i}zp]scale=${WIDTH}:${HEIGHT}:flags=lanczos+accurate_rnd+full_chroma_int,setsar=1[v${i}]`
      );
    }
  }

  let lastLabel = "v0";
  let cumulativeOffset = durations[0];
  for (let i = 1; i < imageCount; i++) {
    const transitionName = transitionOrder[i - 1];
    const tDur = transitionDurations[i - 1];
    const outLabel = i === imageCount - 1 ? "vfinal" : `vx${i}`;
    filters.push(
      `[${lastLabel}][v${i}]xfade=transition=${transitionName}:duration=${tDur}:offset=${cumulativeOffset.toFixed(3)}[${outLabel}]`
    );
    lastLabel = outLabel;
    cumulativeOffset += durations[i] - tDur;
  }
  if (imageCount === 1) lastLabel = "vfinal", filters[filters.length - 1] = filters[filters.length - 1].replace('[v0]', '[vfinal]');

  // تدرج ألوان احترافي (تباين + تشبع + جاما) مدموج مع فلاش الافتتاح الواحد فنفس الفلتر لتفادي
  // تكرار eq. ملاحظة حرجة محفوظة من قبل: eval=frame إجباري باش تعبير الفلاش الزمني يتحسب فـ كل
  // فريم (eval=init الافتراضي كان يقفل القيمة عند t=0 ويسبب شحوب دائم فالفيديو كامل).
  // الترميش المتكرر (نبضة كل 1.1 ثانية طوال الفيديو) تم إزالته بناءً على طلبك.
  // فلاش قوي بعد بداية الفيديو مباشرة (إحساس "كليك الكاميرا")، لكن t=0 بالضبط لازم يبقى نظيف
  // 100% بدون أي رفع سطوع (يُستعمل غالبًا كـ"كفر/thumbnail" تلقائي). نبضة sin ترتفع وتنزل
  // بدل ما تبدا فأقصى قوتها.
  // [تعديل] نطاق أوسع لمدة وذروة الفلاش (بدل نطاق ضيق سابق) — إحساس "كليك كاميرا" أقوى
  // وأكثر تنوعًا بين الفيديوهات. الأمان محفوظ: sin(PI*min(t/flashDur,1)) = 0 بالضبط عند t=0.
  const flashDur = (0.12 + Math.random() * 0.12).toFixed(3);  // بين 0.12 و0.24 ثانية
  const flashPeak = (0.30 + Math.random() * 0.40).toFixed(3); // بين 0.30 و0.70
  const introFlash = `sin(PI*min(t/${flashDur},1))*${flashPeak}`;

  // [تعديل] قيم تدرج الألوان (contrast/saturation/gamma) عشوائية ضمن نطاق ضيق لكل فيديو
  const contrastVal = (1.03 + Math.random() * 0.08).toFixed(3);
  const saturationVal = (1.04 + Math.random() * 0.1).toFixed(3);
  const gammaVal = (0.95 + Math.random() * 0.05).toFixed(3);

  filters.push(
    `[${lastLabel}]eq=contrast=${contrastVal}:saturation=${saturationVal}:gamma=${gammaVal}:brightness='${introFlash}':eval=frame[vflash]`
  );

  // الواترمارك: في منتصف الإطار فوق التصميم، شفاف، بدون حدود أو ظل، مع حركة انسيابية بطيئة (drift)
  // [تعديل] معاملات الـdrift (سعة الحركة، الفترة، الطور) عشوائية لكل فيديو
  const driftAmpX = (16 + Math.random() * 14).toFixed(2);
  const driftPeriodX = (5 + Math.random() * 3).toFixed(2);
  const driftAmpY = (12 + Math.random() * 10).toFixed(2);
  const driftPeriodY = (6 + Math.random() * 4).toFixed(2);
  const driftPhaseY = (Math.random() * Math.PI * 2).toFixed(3);
  const wmDriftX = `(w-text_w)/2 + ${driftAmpX}*sin(2*PI*t/${driftPeriodX})`;
  const wmDriftY = `(h-text_h)/2 + ${driftAmpY}*sin(2*PI*t/${driftPeriodY}+${driftPhaseY})`;
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
  // ثلاث بدايات متتابعة (تتابع لطيف بدل ظهور كل شيء دفعة واحدة): العنوان، ثم masterdxf.com،
  // ثم "تابعونا" تحته أخيرًا.
  const start1 = outroStart;
  const start2 = outroStart + 0.4;
  const start3 = outroStart + 0.8;
  const outroAlpha1 = timeEase('t', start1, 0.25);
  const outroAlpha2 = timeEase('t', start2, 0.25);
  filters.push(
    `[${lastLabel2}]drawtext=fontfile='${fontFile}':textfile='${OUTRO_FILE_1}':fontsize=56:fontcolor=white:` +
    `borderw=6:bordercolor=black:shadowcolor=black@0.6:shadowx=4:shadowy=4:` +
    `x=(w-text_w)/2:y=(h-text_h)/2-90:alpha='${outroAlpha1}'[vout1]`
  );
  filters.push(
    `[vout1]drawtext=fontfile='${fontFile}':textfile='${OUTRO_FILE_2}':fontsize=52:fontcolor=${ACCENT_COLOR}:` +
    `borderw=6:bordercolor=black:shadowcolor=black@0.6:shadowx=4:shadowy=4:` +
    `x=(w-text_w)/2:y=(h-text_h)/2:alpha='${outroAlpha2}'[vout2]`
  );
  // "FOLLOW US" بتأثير كتابة حقيقي (حرف بحرف) بدل fade بسيط — نبني drawtext منفصل لكل بادئة
  // نصية متزايدة (F, FO, FOL, ...) ويُفعَّل كل واحد فقط خلال شريحته الزمنية الخاصة عبر enable.
  const followText = "FOLLOW US";
  const TYPE_DURATION = 0.7; // مدة الكتابة الكاملة بالثواني
  const stepDur = TYPE_DURATION / followText.length;
  let lastLabel3 = "vout2";
  for (let c = 1; c <= followText.length; c++) {
    const substr = followText.slice(0, c);
    const stepFile = path.join(TMP_DIR, `follow_step_${c}.txt`);
    fs.writeFileSync(stepFile, substr);
    const stepStart = (start3 + (c - 1) * stepDur).toFixed(3);
    const isLast = c === followText.length;
    const outLbl = isLast ? "vout3" : `vfw${c}`;
    const enableExpr = isLast
      ? `gte(t\\,${stepStart})`
      : `between(t\\,${stepStart}\\,${(start3 + c * stepDur).toFixed(3)})`;
    filters.push(
      `[${lastLabel3}]drawtext=fontfile='${fontFile}':textfile='${stepFile}':fontsize=50:fontcolor=${FOLLOW_COLOR}:` +
      `borderw=6:bordercolor=black:shadowcolor=black@0.6:shadowx=4:shadowy=4:` +
      `x=(w-text_w)/2:y=(h-text_h)/2+85:enable='${enableExpr}'[${outLbl}]`
    );
    lastLabel3 = outLbl;
  }

  // تحويل صريح ودقيق من RGB (full range) إلى YUV420p (limited range, BT.709) باستعمال zscale.
  // ملاحظة: zscale (مكتبة zimg) قد يفشل بخطأ "no path between colorspaces" إذا كانت الصورة
  // لا تزال بصيغة rgba (فيها قناة alpha)، لذلك نحوّلها إلى rgb24 أولاً.
  filters.push(`[${lastLabel3}]format=rgb24,zscale=matrix=709:range=limited,format=yuv420p[vout]`);

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
  const transitionDurations = computeTransitionDurations(localImages.length, bpm);
  const durations = computeClipDurations(localImages.length, bpm, transitionDurations);
  const totalDuration = durations.reduce((a, b) => a + b, 0) - transitionDurations.reduce((a, b) => a + b, 0);
  console.log(`⏱️ عدد الصور: ${localImages.length} | المدة الإجمالية المستهدفة تحققت: ${totalDuration.toFixed(2)}s`);

  const filterComplex = buildFilterComplex(localImages.length, durations, transitionDurations, totalDuration, hook_text, fontFile);
  const imageInputs = localImages.map(f => `-loop 1 -i "${f}"`).join(' ');
  const outputPath = 'data/latest-video.mp4';
  const safetyDuration = (totalDuration + 0.3).toFixed(2);

  // [تعديل] بداية عشوائية لمقطع الموسيقى (0 إلى 2 ثانية) — يغيّر البصمة الصوتية للمقطع
  // المستعمل من الأغنية بين نسخة وأخرى، حتى لو كانت نفس الأغنية الأصلية.
  const musicStartOffset = (Math.random() * 2).toFixed(2);

  const cmd = [
    'ffmpeg -y',
    '-sws_flags lanczos+accurate_rnd+full_chroma_int',
    imageInputs,
    `-ss ${musicStartOffset} -i "${localMusic}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[vout]"`,
    `-map ${localImages.length}:a`,
    `-af "volume=0.8"`,
    `-t ${safetyDuration}`,
    // [تعديل] ضغط أفضل بنفس الجودة المرئية تقريبًا: crf 21 بدل 18 (near-lossless مبالغ فيه
    // لمحتوى line-art)، preset slower بدل slow لكفاءة ضغط أعلى، وtune=animation لأن المحتوى
    // عبارة عن رسومات مسطحة الألوان بحواف حادة (بالضبط ما هو مصمم له هذا الـtune).
    `-c:v libx264 -profile:v high -preset slower -crf 21 -tune animation -pix_fmt yuv420p`,
    `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`,
    // [تعديل] 128k كافية جدًا لموسيقى خلفية (بدل 192k) بدون فرق مسموع يُذكر
    `-c:a aac -b:a 128k -movflags +faststart`,
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
