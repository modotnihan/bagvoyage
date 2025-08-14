/* ------------------ SW register ------------------ */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js')
    .then(() => console.log('SW registered'))
    .catch(err => console.warn('SW registration failed', err));
}

/* ------------------ Splash hide ------------------ */
window.addEventListener('load', () => {
  setTimeout(() => document.getElementById('splash').classList.add('hidden'), 250);
});

/* ------------------ Helpers ------------------ */
function extractDigits(s){ return (s && s.match(/\d+/g)) ? s.match(/\d+/g).join('') : ''; }
function normalizeBaggageCode(s){
  const d = extractDigits(s);
  return (d.length === 10 || d.length === 13) ? d : '';
}
function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) ||
         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isHoneywell(){
  const ua = (navigator.userAgent || '').toLowerCase();
  return /ct60|ct40|ct45|honeywell|intermec/.test(ua);
}
function todayISO(){
  const d = new Date();
  const z = d.getTimezoneOffset();
  const local = new Date(d.getTime() - z*60000);
  return local.toISOString().slice(0,10);
}
function makeSessionId(date, flight, client){
  return `${date}|${(flight||'').trim().toUpperCase()}|${(client||'').trim()}`;
}
function tsFmt(ts){
  const d = new Date(ts);
  return d.toLocaleString();
}

/* ---------- Fragment combiner for split Code128 ---------- */
const FRAG_WINDOW_MS = 1000;
let fragBuffer = []; // {digits, ts}
function addFragment(d){
  const now=Date.now();
  fragBuffer.push({digits:d, ts:now});
  fragBuffer = fragBuffer.slice(-10).filter((f,i,a)=> now-f.ts<=FRAG_WINDOW_MS && (i===0 || f.digits!==a[i-1].digits));
}
function tryAssemble(){
  if (fragBuffer.length < 2) return '';
  const sorted = fragBuffer.slice().sort((a, b) => b.ts - a.ts);
  const [b, a] = sorted.slice(0, 2).map(f => f.digits);
  if (!a || !b || a === b) return '';
  const ab=a+b, ba=b+a;
  return (ab.length===10 || ab.length===13) ? ab :
         (ba.length===10 || ba.length===13) ? ba :
         (a.length===10 || a.length===13) ? a :
         (b.length===10 || b.length===13) ? b : '';
}

(function init(){
  if(window.__BAGVOYAGE_LOADED__){ console.warn('Bagvoyage already loaded.'); return; }
  window.__BAGVOYAGE_LOADED__ = true;

  // ---------- App State ----------
  let isScanning = false, mode = null, currentTrack = null;
  let lastRead = { code:null, ts:0 };
  let scanCooldownUntil = 0;
  let isTorchOn = false;

  // Persist HID toggle; default ON on Honeywell
  let useHardwareScanner = JSON.parse(localStorage.getItem('bagvoyage_hid') ?? 'null');
  if (useHardwareScanner === null) useHardwareScanner = isHoneywell();

  // Session
  let session = JSON.parse(localStorage.getItem('bagvoyage_session') || 'null');
  // Data storage keys:
  // - bagvoyage_sessions : [{id,date,flight,client}]
  // - bagvoyage_data_<sessionId> : [{code,ts,type:'tag'|'retrieve', matched:boolean}]
  const SESSIONS_KEY = 'bagvoyage_sessions';

  // ---------- Local DB (session-scoped) ----------
  function listSessions(){
    try { return JSON.parse(localStorage.getItem(SESSIONS_KEY)||'[]'); } catch { return []; }
  }
  function saveSessionMeta(meta){
    const all = listSessions().filter(x=>x.id!==meta.id);
    all.unshift(meta);
    try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(all.slice(0,200))); }
    catch (e) { console.warn('Session meta save failed', e); }
  }
  function dataKey(id){ return `bagvoyage_data_${id}`; }
  function getData(id){
    try { return JSON.parse(localStorage.getItem(dataKey(id))||'[]'); } catch { return []; }
  }
  function setData(id, arr){
    try { localStorage.setItem(dataKey(id), JSON.stringify(arr)); } catch(e){ console.warn('Storage failed', e); }
  }
  function addRecord(rec){
    if (!session?.id) return;
    const arr = getData(session.id);
    arr.unshift(rec);
    setData(session.id, arr.slice(0,2000));
  }
  function findTag(code){
    if (!session?.id) return null;
    const n = normalizeBaggageCode(code);
    const arr = getData(session.id);
    return arr.find(x=> x.type==='tag' && x.code===n) || null;
  }

  // ---------- DOM ----------
  const $home = document.getElementById('home');
  const $scan = document.getElementById('scan');
  const $setup = document.getElementById('setup');

  const $title = document.getElementById('modeTitle');
  const $video = document.getElementById('preview');
  const $sheet = document.getElementById('sheet');
  const $pill = document.getElementById('pill');
  const $sheetTitle = document.getElementById('sheetTitle');
  const $sheetCode = document.getElementById('sheetCode');
  const $btnContinue = document.getElementById('btnContinue');
  const $toast = document.getElementById('toast');
  const $dbDot = document.getElementById('dbDot');
  const $dbLabel = document.getElementById('dbLabel');
  const $camDot = document.getElementById('camDot');
  const $camLabel = document.getElementById('camLabel');
  const $manualDlg = document.getElementById('manualDialog');
  const $manualInput = document.getElementById('manualInput');
  const $savedTick = document.getElementById('savedTick');
  const $scannerInput = document.getElementById('scannerInput'); // kept for compat (unused focus)
  const $ptr = document.getElementById('ptrIndicator');
  const $torchBtn = document.getElementById('btnTorch');
  const $hidBtn = document.getElementById('btnHID');
  const $btnDetails = document.getElementById('btnDetails');
  const $btnOpenDetails = document.getElementById('btnOpenDetails');
  const $detailsDlg = document.getElementById('detailsDialog');
  const $detailsDate = document.getElementById('detailsDate');
  const $detailsFlight = document.getElementById('detailsFlight');
  const $detailsClient = document.getElementById('detailsClient');
  const $detailsTbody = document.getElementById('detailsTbody');
  const $cntTag = document.getElementById('cntTag');
  const $cntRetrieve = document.getElementById('cntRetrieve');
  const $cntMatched = document.getElementById('cntMatched');
  const $cntUnmatched = document.getElementById('cntUnmatched');
  const $sessionPill = document.getElementById('sessionPill');

  // Setup form
  const $setupForm = document.getElementById('setupForm');
  const $setupDate = document.getElementById('setupDate');
  const $setupFlight = document.getElementById('setupFlight');
  const $setupClient = document.getElementById('setupClient');
  const $setupRemember = document.getElementById('setupRemember');
  const $setupDetails = document.getElementById('setupDetails');

  // Status UI
  setTimeout(()=>{ $dbDot.className='dot ok'; $dbLabel.textContent='DB: online (local)'; }, 300);

  const vibrate = p => { try{ navigator.vibrate && navigator.vibrate(p) }catch{} };
  const toast = (msg, ms=900) => { $toast.textContent=msg; $toast.classList.add('show'); setTimeout(()=>$toast.classList.remove('show'), ms); };

  /* ---------- GLOBAL HID CAPTURE (no input focus, no soft keyboard) ---------- */
  let hidActive = false;
  let hidBuffer = '';
  let hidTimer = null;
  const HID_IDLE_MS = 60;

  function enableHIDCapture(){
    if (hidActive) return;
    hidActive = true;
    hidBuffer = '';
    try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
    document.addEventListener('keydown', onHIDKeyDown, true);
  }
  function disableHIDCapture(){
    if (!hidActive) return;
    hidActive = false;
    document.removeEventListener('keydown', onHIDKeyDown, true);
    hidBuffer = '';
    clearTimeout(hidTimer); hidTimer = null;
  }
  function onHIDKeyDown(e){
    if (!useHardwareScanner) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      const code = hidBuffer.trim();
      hidBuffer = '';
      if (code) onScan(code);
      return;
    }

    if (e.key && e.key.length === 1) {
      const ch = e.key;
      if (/^[0-9A-Za-z\-_/+]+$/.test(ch)) {
        hidBuffer += ch;
        clearTimeout(hidTimer);
        hidTimer = setTimeout(()=>{
          const code = hidBuffer.trim();
          hidBuffer = '';
          if (code.length >= 8) onScan(code);
        }, HID_IDLE_MS);
        e.preventDefault();
      }
    }
  }

  /* ---------- Torch capability & control ---------- */
  async function hasImageCaptureTorch(track){
    try {
      if (!('ImageCapture' in window) || !track || track.kind !== 'video') return false;
      const ic = new ImageCapture(track);
      const caps = await ic.getPhotoCapabilities().catch(() => null);
      return !!(caps && Array.isArray(caps.fillLightMode) && caps.fillLightMode.includes('torch'));
    } catch { return false; }
  }
  function hasTrackTorch(track){
    try {
      const caps = track?.getCapabilities?.();
      return !!(caps && 'torch' in caps);
    } catch { return false; }
  }
  async function setTorch(on){
    if (!currentTrack || useHardwareScanner) return false;
    try{
      if (await hasImageCaptureTorch(currentTrack)) {
        const ic = new ImageCapture(currentTrack);
        await ic.setOptions({ torch: !!on });
        isTorchOn = !!on;
      } else if (hasTrackTorch(currentTrack)) {
        await currentTrack.applyConstraints({ advanced: [{ torch: !!on }] });
        isTorchOn = !!on;
      } else {
        isTorchOn = false;
        return false;
      }
      $torchBtn.textContent = isTorchOn ? 'Torch Off' : 'Torch On';
      $torchBtn.setAttribute('aria-pressed', String(isTorchOn));
      return true;
    } catch (e){
      console.warn('Torch control failed:', e);
      return false;
    }
  }
  async function updateTorchUI(){
    if (useHardwareScanner) {
      $torchBtn.disabled = true;
      $torchBtn.title = 'Torch disabled in Hardware Scanner mode';
      $torchBtn.setAttribute('aria-disabled', 'true');
      $torchBtn.textContent = 'Torch';
      $torchBtn.setAttribute('aria-pressed', 'false');
      return;
    }
    if (!currentTrack) { $torchBtn.disabled = true; $torchBtn.title = 'Camera not ready'; return; }
    const supported = await hasImageCaptureTorch(currentTrack) || hasTrackTorch(currentTrack);
    $torchBtn.disabled = !supported;
    $torchBtn.title = supported ? 'Toggle torch' : 'Torch not supported by this camera';
    $torchBtn.setAttribute('aria-disabled', String(!supported));
    if (!supported) {
      isTorchOn = false;
      $torchBtn.textContent = 'Torch';
      $torchBtn.setAttribute('aria-pressed', 'false');
    }
  }

  /* ---------- Camera selection ---------- */
  async function getBestBackCameraStream(){
    const provisional = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false
    }).catch(() => null);

    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const candidates = [];
    for (const d of devices) {
      const label = (d.label || '').toLowerCase();
      const isBack = /back|rear|environment/.test(label);
      candidates.push({ deviceId: d.deviceId, score: isBack ? 2 : 1, label });
    }
    candidates.sort((a,b) => b.score - a.score);

    for (const c of candidates) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: c.deviceId },
          width:{ ideal:1280, min:960 },
          height:{ ideal:720,  min:540 },
          aspectRatio:{ ideal:16/9 },
          frameRate:{ ideal:30,  min:15 }
        },
        audio:false
      }).catch(() => null);

      if (!stream) continue;

      const track = stream.getVideoTracks()[0];
      const supports = hasTrackTorch(track) || await hasImageCaptureTorch(track);
      if (supports) {
        if (provisional && provisional !== stream) provisional.getTracks().forEach(t => t.stop());
        return stream;
      }
      stream.getTracks().forEach(t => t.stop());
    }

    if (provisional) return provisional;

    return navigator.mediaDevices.getUserMedia({
      video: {
        facingMode:{ ideal:'environment' },
        width:{ ideal:1280, min:960 }, height:{ ideal:720, min:540 },
        aspectRatio:{ ideal:16/9 }, frameRate:{ ideal:30, min:15 }
      },
      audio:false
    });
  }

  /* ---------- Result sheet ---------- */
  function openSheet(kind, title, code, wait){
    $btnContinue.replaceWith($btnContinue.cloneNode(true));
    const freshBtn = document.getElementById('btnContinue');
    freshBtn.addEventListener('click', onContinue, { once:true });

    $pill.className = 'pill ' + (kind==='ok'?'ok':'bad');
    $pill.textContent = kind==='ok' ? 'MATCH' : 'UNMATCHED';
    $sheetTitle.textContent = title;
    $sheetCode.textContent = code;

    freshBtn.classList.toggle('hidden', !wait);
    freshBtn.setAttribute('tabindex', wait ? '0' : '-1');

    $sheet.classList.add('show');
    if (!wait) setTimeout(()=> $sheet.classList.remove('show'), 900);
    if (wait) freshBtn.focus();
  }
  function hideSheet(){
    $sheet.classList.remove('show');
  }

  /* ---------- UI helpers ---------- */
  function setCamStatus(active){
    if(active){ $camDot.className='dot ok'; $camLabel.textContent='Camera: active'; }
    else { $camDot.className='dot'; $camLabel.textContent='Camera: idle'; }
  }
  function showSavedTick(ms = 900){
    $savedTick.classList.add('show');
    setTimeout(()=> $savedTick.classList.remove('show'), ms);
  }
  function setSessionPill(){
    if (!session) { $sessionPill.textContent = 'No session'; return; }
    $sessionPill.textContent = `Session: ${session.date} • ${session.flight} • ${session.client}`;
  }
  function showHome(){
    $scan.classList.add('hidden');
    $home.classList.remove('hidden');
    $setup.classList.add('hidden');
    mode=null;
    setCamStatus(false);
    $scan.classList.remove('active');
    hideSheet();
    disableHIDCapture();
    setSessionPill();
  }
  function showScan(m){
    mode=m;
    $title.textContent = m==='tag'?'Tag — scanning':'Retrieve — scan to verify';
    $home.classList.add('hidden');
    $scan.classList.remove('hidden');
    $scan.classList.add('active');
    if (useHardwareScanner) {
      disableHIDCapture(); enableHIDCapture();
    } else {
      disableHIDCapture();
    }
  }
  function showSetup(){
    $home.classList.add('hidden');
    $scan.classList.add('hidden');
    $setup.classList.remove('hidden');
    disableHIDCapture();
  }

  /* ---------- Camera start/stop ---------- */
  async function startScan(m){
    if (!session?.id) { toast('Please complete setup first'); showSetup(); return; }
    if (isScanning) return;
    showScan(m);

    // HID
    if (useHardwareScanner) {
      isScanning = false;
      setCamStatus(false);
      await stopCamera();
      await updateTorchUI();
      return;
    }

    // Camera path
    isScanning = true;
    setCamStatus(true);
    await stopCamera();
    try{
      const stream = await getBestBackCameraStream();
      $video.srcObject = stream;
      await $video.play().catch(()=>{});
      if ($video.readyState < 2) {
        await new Promise(res => $video.addEventListener('loadedmetadata', res, { once:true }));
      }
      currentTrack = stream.getVideoTracks()[0] || null;
      await updateTorchUI();

      const canUseNative =
        !isIOS() &&
        'BarcodeDetector' in window &&
        typeof BarcodeDetector === 'function';

      if (canUseNative) {
        let supported = [];
        try { supported = await BarcodeDetector.getSupportedFormats(); } catch {}
        if (!Array.isArray(supported)) supported = []; // guard

        const wanted = ['code_128', 'itf', 'ean_13', 'ean_8', 'upc_a', 'qr_code'];
        const formats = wanted.filter(f => supported.includes(f));
        if (formats.length) {
          const detector = new BarcodeDetector({ formats });
          let running = true;

          const frameLoop = async () => {
            if (!isScanning || !running || useHardwareScanner) return;
            if (Date.now() < scanCooldownUntil) {
              $video.requestVideoFrameCallback(() => frameLoop());
              return;
            }
            try {
              const codes = await detector.detect($video);
              if (codes && codes.length) {
                const value = (codes[0].rawValue || '').trim();
                if (value) {
                  scanCooldownUntil = Date.now() + 500;
                  onScan(value);
                }
              }
            } catch (e) {
              console.warn('Native detect failed, falling back to ZXing once:', e);
              running = false;
              await startZXingDecode();
              return;
            }
            $video.requestVideoFrameCallback(() => frameLoop());
          };
          $video.requestVideoFrameCallback(() => frameLoop());
          window.__bagvoyage_native_running__ = () => { running = false; };
          return;
        }
      }

      await startZXingDecode();
      return;

    }catch(e){
      console.error('[Bagvoyage] startScan error:', e);
      toast('Camera access failed: ' + (e?.message||e), 1500);
      await stopCamera();
      showHome();
    }
  }

  // ZXing init, bound to SAME device as currentTrack
  async function startZXingDecode() {
    const ZXB = window.ZXingBrowser || {};
    const ReaderClass = ZXB.BrowserMultiFormatReader;
    if (!ReaderClass) throw new Error('ZXing library not loaded');

    const reader = new ReaderClass();
    const BF = ZXB.BarcodeFormat, HT = ZXB.DecodeHintType;
    let hints;
    if (BF && HT) {
      const fmts = [BF.ITF, BF.CODE_128, BF.CODE_39, BF.EAN_13, BF.EAN_8, BF.UPC_A, BF.QR_CODE].filter(Boolean);
      hints = new Map();
      hints.set(HT.TRY_HARDER, true);
      hints.set(HT.POSSIBLE_FORMATS, fmts);
    }

    const settings = (currentTrack && currentTrack.getSettings) ? currentTrack.getSettings() : {};
    const deviceId = settings.deviceId || undefined;

    await reader.decodeFromVideoDevice(
      deviceId,
      $video,
      (result, err) => {
        if (!isScanning || !result || useHardwareScanner) return;
        if (Date.now() < scanCooldownUntil) return;

        const raw = result.getText();
        if (!raw) return;

        const digits = extractDigits(raw);
        if (digits) addFragment(digits);
        const assembled = tryAssemble();
        const processed = normalizeBaggageCode(raw) || digits || raw;
        const payload   = assembled || processed;
        if (!payload) return;

        scanCooldownUntil = Date.now() + 500;
        fragBuffer = [];
        onScan(payload);
      },
      hints
    );

    window.__bagvoyage_reader__ = reader;
  }

  async function stopCamera(){
    try { await setTorch(false); } catch {}
    try { window.__bagvoyage_native_running__ && window.__bagvoyage_native_running__(); } catch {}
    try { window.__bagvoyage_reader__?.reset?.(); } catch {}
    const stream = $video.srcObject;
    if (stream) {
      const tracks = stream.getVideoTracks();
      tracks.forEach(t => { try { t.stop(); } catch {} });
    }
    $video.pause();
    $video.srcObject = null;
    currentTrack = null;
    setCamStatus(false);
    await updateTorchUI().catch(()=>{});
  }

  function stopScan(){
    if(!isScanning) return;
    isScanning = false;
    hideSheet();
    stopCamera();
  }

  /* ---------- Scan handler (session-aware) ---------- */
  async function onScan(text){
    if (!session?.id) { toast('No active session'); return; }

    const codeRaw = (text||'').trim();
    if(!codeRaw) return;
    const now = Date.now();
    if(codeRaw===lastRead.code && (now-lastRead.ts)<1200) return; // de-dupe
    lastRead = { code: codeRaw, ts: now };

    const code = normalizeBaggageCode(codeRaw) || extractDigits(codeRaw) || codeRaw;

    if(mode==='tag'){
      addRecord({ code, ts: now, type:'tag', matched:false });
      vibrate(30);
      showSavedTick();
      toast('Tag saved', 700);
    }else if(mode==='retrieve'){
      const matched = !!findTag(code);
      addRecord({ code, ts: now, type:'retrieve', matched });

      if(matched){
        vibrate([40,60,40]);
        isScanning = false;
        await stopCamera();
        openSheet('ok','MATCH',code,true);
      } else {
        vibrate([30,40,30]);
        openSheet('bad','UNMATCHED',code,false);
      }
    }
  }

  /* ---------- Continue flow ---------- */
  async function onContinue(e){
    if (e && e.preventDefault) e.preventDefault();
    hideSheet();
    isScanning = false;
    if (mode !== 'retrieve') mode = 'retrieve';

    if (useHardwareScanner) {
      await stopCamera();
      try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
      return;
    }
    await startScan('retrieve');
  }

  /* ---------- Setup screen logic ---------- */
  function startSession(date, flight, client){
    session = { id: makeSessionId(date, flight, client), date, flight: flight.toUpperCase(), client };
    try { localStorage.setItem('bagvoyage_session', JSON.stringify(session)); }
    catch (e) { console.warn('Session save failed', e); }
    saveSessionMeta(session);
  }

  $setupForm.addEventListener('submit', (e)=>{
    e.preventDefault();
    const date = document.getElementById('setupDate').value || todayISO();
    const flight = (document.getElementById('setupFlight').value||'').trim();
    const client = (document.getElementById('setupClient').value||'').trim();
    const remember = document.getElementById('setupRemember').checked;
    if (!flight || !client) return;
    startSession(date, flight, client);
    if (!remember) {
      // Ephemeral session: clear on pagehide
      window.addEventListener('pagehide', ()=> localStorage.removeItem('bagvoyage_session'), { once:true });
    }
    toast('Session ready', 700);
    showHome();
  });

  document.getElementById('setupDetails').addEventListener('click', ()=>{
    // Pre-fill details dialog with setup values (unsaved yet)
    const date = document.getElementById('setupDate').value || todayISO();
    const flight = (document.getElementById('setupFlight').value||'').trim();
    const client = (document.getElementById('setupClient').value||'').trim();
    openDetails({ date, flight, client });
  });

  /* ---------- Details dialog ---------- */
  function loadRecords(filter){
    const all = listSessions();
    let ids = [];
    if (filter.date && filter.flight && filter.client) {
      ids = [ makeSessionId(filter.date, filter.flight, filter.client) ];
    } else {
      ids = all
        .filter(s =>
          (!filter.date   || s.date === filter.date) &&
          (!filter.flight || s.flight.toUpperCase() === (filter.flight||'').trim().toUpperCase()) &&
          (!filter.client || s.client === filter.client)
        )
        .map(s=>s.id);
    }
    let recs = [];
    ids.forEach(id => { recs = recs.concat(getData(id)); });
    return recs.sort((a,b)=> b.ts - a.ts);
  }

  function renderDetails(filter){
    const recs = loadRecords(filter);
    let tag=0, ret=0, mat=0, un=0;
    $detailsTbody.innerHTML = '';
    for (const r of recs) {
      if (r.type==='tag') tag++;
      if (r.type==='retrieve') { ret++; r.matched ? mat++ : un++; }
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${tsFmt(r.ts)}</td><td>${r.code}</td><td>${r.type}</td><td>${r.type==='retrieve' ? (r.matched?'Yes':'No') : '-'}</td>`;
      $detailsTbody.appendChild(tr);
    }
    $cntTag.textContent = String(tag);
    $cntRetrieve.textContent = String(ret);
    $cntMatched.textContent = String(mat);
    $cntUnmatched.textContent = String(un);
  }

  function openDetails(prefill){
    $detailsDate.value = prefill?.date || (session?.date || todayISO());
    $detailsFlight.value = prefill?.flight || (session?.flight || '');
    $detailsClient.value = prefill?.client || (session?.client || '');
    renderDetails({ date:$detailsDate.value, flight:$detailsFlight.value, client:$detailsClient.value });
    $detailsDlg.showModal();
  }

  // Details events
  $btnDetails.addEventListener('click', ()=> openDetails());
  $btnOpenDetails.addEventListener('click', ()=> openDetails());
  $detailsDate.addEventListener('change', ()=> renderDetails({ date:$detailsDate.value, flight:$detailsFlight.value, client:$detailsClient.value }));
  $detailsFlight.addEventListener('input', ()=> renderDetails({ date:$detailsDate.value, flight:$detailsFlight.value, client:$detailsClient.value }));
  $detailsClient.addEventListener('input', ()=> renderDetails({ date:$detailsDate.value, flight:$detailsFlight.value, client:$detailsClient.value }));

  // Export CSV (with session-based filename)
  document.getElementById('btnExport').addEventListener('click', ()=>{
    const recs = loadRecords({ date:$detailsDate.value, flight:$detailsFlight.value, client:$detailsClient.value });
    const header = ['Timestamp','Code','Type','Matched'];
    const rows = recs.map(r=>[
      new Date(r.ts).toISOString(),
      r.code,
      r.type,
      r.type==='retrieve' ? (r.matched?'Yes':'No') : ''
    ]);
    const csv = [header].concat(rows).map(r=>r.map(v=>String(v).replace(/"/g,'""')).map(v=>`"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    const nameBits = [
      $detailsDate.value || 'all',
      ($detailsFlight.value||'').replace(/\s+/g,'_') || 'any',
      ($detailsClient.value||'').replace(/\s+/g,'_') || 'any'
    ];
    a.href = url; a.download = `bag_details_${nameBits.join('_')}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });

  // Print (popup-blocker safe)
  document.getElementById('btnPrint').addEventListener('click', ()=>{
    const win = window.open('', '_blank');
    if (!win) { toast('Pop-up blocked. Allow pop-ups to print.'); return; } // guard
    const title = `Bag details — ${$detailsDate.value || ''} ${$detailsFlight.value || ''} ${$detailsClient.value || ''}`.trim();
    win.document.write(`
      <html><head><title>${title}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1"/>
      <style>
        body{font-family:Inter,system-ui,sans-serif;padding:16px}
        h1{font-size:18px;margin:0 0 10px}
        table{width:100%;border-collapse:collapse}
        th,td{border:1px solid #999;padding:6px;font-size:13px}
        th{background:#eee;text-align:left}
      </style></head><body>
      <h1>${title}</h1>
      <table>
        <thead><tr><th>Time</th><th>Code</th><th>Type</th><th>Matched</th></tr></thead>
        <tbody>${$detailsTbody.innerHTML}</tbody>
      </table>
      </body></html>`);
    win.document.close();
    win.focus();
    win.print();
  });

  /* ---------- Buttons ---------- */
  document.getElementById('btnStop').addEventListener('click', async ()=>{
    await stopScan();
    showHome();
  });

  document.getElementById('btnTag').addEventListener('click', ()=> startScan('tag'));
  document.getElementById('btnRetrieve').addEventListener('click', ()=> startScan('retrieve'));

  document.getElementById('btnManual').addEventListener('click', ()=>{
    $manualInput.value='';
    $manualDlg.showModal();
  });
  document.getElementById('manualApply').addEventListener('click', (e)=>{
    e.preventDefault();
    const v = ($manualInput.value||'').trim();
    if(!v) return;
    if(!mode || mode==='tag'){
      addRecord({ code: normalizeBaggageCode(v)||v, ts: Date.now(), type:'tag', matched:false });
      showSavedTick(); toast('Tag saved', 700);
    } else {
      const code = normalizeBaggageCode(v)||v;
      const matched = !!findTag(code);
      addRecord({ code, ts:Date.now(), type:'retrieve', matched });
      matched ? openSheet('ok','MATCH',code,true) : openSheet('bad','UNMATCHED',code,false);
    }
    $manualDlg.close();
    if (useHardwareScanner) { try{ document.activeElement && document.activeElement.blur && document.activeElement.blur(); }catch{} }
  });

  // HID toggle
  $hidBtn.addEventListener('click', async ()=>{
    useHardwareScanner = !useHardwareScanner;
    try { localStorage.setItem('bagvoyage_hid', JSON.stringify(useHardwareScanner)); }
    catch(e){ console.warn('HID toggle save failed', e); }
    $hidBtn.textContent = `Hardware Scanner: ${useHardwareScanner ? 'On' : 'Off'}`;
    toast(useHardwareScanner ? 'Hardware scanner enabled' : 'Camera scanner enabled', 700);

    if (useHardwareScanner) {
      isScanning = false;
      await stopCamera();
      setCamStatus(false);
      await updateTorchUI();
      enableHIDCapture();
      try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
    } else {
      disableHIDCapture();
      await updateTorchUI();
      if ($scan && !$scan.classList.contains('hidden') && mode) {
        await startScan(mode);
      }
    }
  });

  /* ---------- Lifecycle ---------- */
  window.addEventListener('pagehide', () => { stopScan(); disableHIDCapture(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopScan();
      disableHIDCapture();
    } else if (mode) {
      if (useHardwareScanner) {
        enableHIDCapture();
        stopCamera();
        setCamStatus(false);
        updateTorchUI();
        try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
      } else if (!$scan.classList.contains('hidden')) { // only if scan screen is visible
        startScan(mode);
      }
    }
  });

  // ---------- Init flow ----------
  document.getElementById('setupDate').value = todayISO();
  $hidBtn.textContent = `Hardware Scanner: ${useHardwareScanner ? 'On' : 'Off'}`;
  if (session?.id) showHome(); else showSetup();
})();
