'use strict'

/* Джарвис: чат, голос браузера, память, таймер и настройки. Зависимостей нет. */

const el = (id) => document.getElementById(id)

const state = {
  messages: [],
  notes: [],
  settings: { model: "", voice: "", autospeak: true, systemPrompt: "" },
  models: [],
  busy: false,
  controller: null,
  recognizing: false,
  handsFree: true,
  engine: "web",
  noWake: false,
  speaking: false,
  followUpUntil: 0,
  micStarted: false,
  micBlocked: false,
  timer: null,
  voices: [],
  lastReply: "",
}

/* ---------- сеть ---------- */

async function api(path, body, method) {
  const options = { method: method || (body === undefined ? "GET" : "POST"), headers: {} }
  if (body !== undefined) {
    options.headers["content-type"] = "application/json"
    options.body = JSON.stringify(body)
  }
  const res = await fetch(path, options)
  const text = await res.text()
  let data = {}
  try {
    data = text === "" ? {} : JSON.parse(text)
  } catch {
    throw new Error("Сервер ответил не JSON: " + text.slice(0, 120))
  }
  if (!res.ok && data.error === undefined) throw new Error("HTTP " + res.status)
  return data
}

/* ---------- сообщения ---------- */

function addMessage(role, text) {
  const wrap = document.createElement("div")
  wrap.className = "msg " + role
  const avatar = document.createElement("div")
  avatar.className = "avatar"
  avatar.textContent = role === "user" ? "Я" : "J"
  const bubble = document.createElement("div")
  bubble.className = "bubble"
  const body = document.createElement("span")
  body.className = "body"
  body.textContent = text
  bubble.appendChild(body)
  wrap.append(avatar, bubble)
  el("chat").appendChild(wrap)
  scrollChat()
  return { wrap, bubble, body }
}

function scrollChat() {
  const chat = el("chat")
  chat.scrollTop = chat.scrollHeight
}

function setBusy(busy) {
  state.busy = busy
  el("sendBtn").hidden = busy
  el("stopBtn").hidden = !busy
  el("reactor").classList.toggle("active", busy)
}

function stopAll() {
  if (state.controller !== null) {
    state.controller.abort()
    state.controller = null
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel()
  state.speaking = false
  state.followUpUntil = 0
  setBusy(false)
  setListening(false)
}

async function send(text) {
  const clean = String(text || "").trim()
  if (clean === "" || state.busy) return
  el("input").value = ""
  resizeInput()
  addMessage("user", clean)
  state.messages.push({ role: "user", content: clean })

  const target = addMessage("assistant", "")
  target.bubble.classList.add("streaming")
  const controller = new AbortController()
  state.controller = controller
  setBusy(true)

  let answer = ""
  let kind = "llm"
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: state.messages.slice(-14), model: state.settings.model || undefined }),
      signal: controller.signal,
    })
    if (!res.ok || res.body === null) throw new Error("Маршрут ответил " + res.status)
    await readStream(res.body, (event) => {
      if (event.type === "delta") {
        answer += event.text
        target.body.textContent = answer
        scrollChat()
      } else if (event.type === "done") {
        kind = event.kind || "llm"
        if (typeof event.text === "string" && event.text !== "") answer = event.text
        if (event.timer) startTimer(event.timer.seconds, event.timer.label)
        if (Array.isArray(event.notes)) renderNotes(event.notes)
        if (event.model) addModelChip(event.model)
      } else if (event.type === "error") {
        throw new Error(event.message)
      }
    })
    target.body.textContent = answer.replace(/^\s+|\s+$/g, "")
    state.messages.push({ role: "assistant", content: answer })
    state.lastReply = answer
    if (state.settings.autospeak && answer !== "") speak(answer)
  } catch (error) {
    if (error.name === "AbortError") {
      target.bubble.classList.add("error")
      target.body.textContent = answer === "" ? "Остановлено" : answer
    } else {
      target.bubble.classList.add("error")
      target.body.textContent = "Ошибка: " + (error.message || error)
      if (state.settings.autospeak) speak("Не удалось получить ответ")
    }
  } finally {
    target.bubble.classList.remove("streaming")
    state.controller = null
    setBusy(false)
    if (state.handsFree && !state.speaking) scheduleListen()
  }
}

async function readStream(body, onEvent) {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf("\n\n")
    while (index !== -1) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const line = block.split("\n").find((item) => item.startsWith("data:"))
      if (line !== undefined) {
        const payload = line.slice(5).trim()
        if (payload !== "") {
          try {
            onEvent(JSON.parse(payload))
          } catch {
            /* пропускаем битое событие */
          }
        }
      }
      index = buffer.indexOf("\n\n")
    }
  }
}

/* ---------- голос: распознавание ---------- */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
let recognition = null

function createRecognition() {
  if (SpeechRecognition === undefined) return null
  const instance = new SpeechRecognition()
  instance.lang = "ru-RU"
  instance.interimResults = true
  instance.continuous = true
  instance.maxAlternatives = 1
  instance.onstart = () => {
    state.recognizing = true
    state.micStarted = true
    el("micBtn").setAttribute("aria-pressed", "true")
    updateVoiceIndicator()
    console.log("[jarvis] mic start")
  }
  instance.onend = () => {
    state.recognizing = false
    el("micBtn").setAttribute("aria-pressed", "false")
    el("heard").hidden = true
    updateVoiceIndicator()
    console.log("[jarvis] mic end")
    if (state.handsFree && !state.micBlocked && !state.busy) scheduleListen()
  }
  instance.onerror = (event) => {
    state.recognizing = false
    el("micBtn").setAttribute("aria-pressed", "false")
    el("heard").hidden = true
    updateVoiceIndicator()
    console.log("[jarvis] mic error " + event.error)
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      state.micBlocked = true
      addMessage("assistant", "Браузер не дал доступ к микрофону: нажми на кнопку микрофона или разреши доступ в настройках сайта.")
    } else if (event.error === "network") {
      state.micBlocked = true
      addMessage("assistant", "Распознавание речи не доходит до сервера (ошибка сети). Отключи VPN/блокировщик для этого сайта или включи режим «Без обращения» в настройках.")
    }
  }
  instance.onresult = (event) => {
    let text = ""
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      text += event.results[index][0].transcript
    }
    const final = event.results[event.results.length - 1].isFinal
    if (!state.handsFree) {
      el("input").value = text.trim()
      resizeInput()
    }
    if (final) handlePhrase(text)
  }
  return instance
}

/** Обрабатывает распознанную фразу: отбрасывает обращения, отправляет остальное в чат. */
function handlePhrase(phrase) {
  const text = String(phrase || "").trim()
  if (text === "") return
  if (state.speaking) return
  if (state.handsFree) {
    const parsed = stripWake(text)
    if (parsed === null) {
      if (state.noWake || Date.now() < state.followUpUntil) send(text)
      return
    }
    if (parsed.rest === "") {
      addMessage("assistant", "Слушаю, Андрей.")
      if (state.settings.autospeak) speak("Слушаю, Андрей.")
      scheduleListen()
      return
    }
    send(parsed.rest)
    return
  }
  send(text)
}

const stripWake = JarvisWake.stripWake

function updateVoiceIndicator() {
  const chip = el("voiceChip")
  const gate = el("micGate")
  el("micBtn").classList.toggle("live", state.recognizing === true)
  if (gate !== null) gate.hidden = !(state.handsFree && hasMic() && !state.recognizing && (!state.micStarted || state.micBlocked))
  if (chip === null) return
  chip.hidden = !(state.handsFree && hasMic())
  chip.textContent = state.recognizing ? "\u25cf слушаю" : "\u25cb пауза"
  chip.classList.toggle("live", state.recognizing === true)
}

function hasMic() {
  return state.engine === "local" || recognition !== null
}

/* ---------- голос: локальное распознавание (Vosk) ---------- */

const local = {
  ctx: null,
  stream: null,
  source: null,
  processor: null,
  events: null,
  sending: false,
  inflight: 0,
  starting: false,
}

function localEvents() {
  if (local.events !== null) return
  const source = new EventSource("/api/stt/events")
  source.onmessage = (event) => {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (data.type === "partial") {
      if (data.text !== "") {
        el("heard").hidden = false
        el("heard").textContent = "слышу: " + data.text
      }
      return
    }
    if (data.type === "final") {
      el("heard").hidden = true
      console.log("[jarvis] local final: " + data.text)
      handlePhrase(data.text)
      return
    }
    if (data.type === "ready") console.log("[jarvis] stt ready")
    if (data.type === "error") {
      console.log("[jarvis] stt error: " + data.message)
      state.micBlocked = true
      updateVoiceIndicator()
    }
  }
  local.events = source
}

function toPcm16(samples, rate) {
  let data = samples
  if (rate !== 16000) {
    const ratio = rate / 16000
    const length = Math.floor(samples.length / ratio)
    data = new Float32Array(length)
    for (let index = 0; index < length; index += 1) {
      const position = index * ratio
      const left = Math.floor(position)
      const right = Math.min(left + 1, samples.length - 1)
      const mix = position - left
      data[index] = samples[left] * (1 - mix) + samples[right] * mix
    }
  }
  const pcm = new Int16Array(data.length)
  for (let index = 0; index < data.length; index += 1) {
    const value = Math.max(-1, Math.min(1, data[index]))
    pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff
  }
  return new Uint8Array(pcm.buffer)
}

async function localStart() {
  if (state.engine !== "local" || local.stream !== null || local.starting) return
  local.starting = true
  try {
    localEvents()
    const started = await fetch("/api/stt/start", { method: "POST" }).then((res) => res.json())
    if (started.ok !== true) throw new Error(started.error || "нет модели распознавания")
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    const ctx = new AudioContext({ sampleRate: 16000 })
    await ctx.resume()
    const source = ctx.createMediaStreamSource(stream)
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    const rate = ctx.sampleRate
    processor.onaudioprocess = (event) => {
      if (!local.sending || local.inflight > 2) return
      const pcm = toPcm16(event.inputBuffer.getChannelData(0), rate)
      local.inflight += 1
      fetch("/api/stt/chunk", { method: "POST", body: pcm })
        .catch(() => {})
        .finally(() => {
          local.inflight -= 1
        })
    }
    source.connect(processor)
    processor.connect(ctx.destination)
    local.ctx = ctx
    local.stream = stream
    local.source = source
    local.processor = processor
    local.sending = true
    state.recognizing = true
    state.micStarted = true
    state.micBlocked = false
    el("micBtn").setAttribute("aria-pressed", "true")
    updateVoiceIndicator()
    console.log("[jarvis] local mic on, rate=" + rate)
  } catch (error) {
    console.log("[jarvis] local mic failed: " + (error.message || error))
    state.micBlocked = true
    state.recognizing = false
    updateVoiceIndicator()
  } finally {
    local.starting = false
  }
}

function localPause() {
  local.sending = false
  state.recognizing = false
  el("heard").hidden = true
  updateVoiceIndicator()
}

function localResume() {
  if (local.stream === null) return
  local.sending = true
  state.recognizing = true
  updateVoiceIndicator()
}

function localStop() {
  local.sending = false
  if (local.processor !== null) local.processor.disconnect()
  if (local.source !== null) local.source.disconnect()
  if (local.stream !== null) local.stream.getTracks().forEach((track) => track.stop())
  if (local.ctx !== null) local.ctx.close().catch(() => {})
  local.processor = null
  local.source = null
  local.stream = null
  local.ctx = null
  state.recognizing = false
  el("heard").hidden = true
  updateVoiceIndicator()
  fetch("/api/stt/stop", { method: "POST" }).catch(() => {})
}

function setListening(on) {
  if (state.engine === "local") {
    if (on) {
      if (local.stream !== null) localResume()
      else localStart().catch(() => {})
    } else {
      localPause()
    }
    return
  }
  if (recognition === null) return
  if (on && !state.recognizing) {
    try {
      recognition.start()
    } catch {
      /* уже слушаем */
    }
  }
  if (!on && state.recognizing) {
    try {
      recognition.stop()
    } catch {
      /* уже остановлено */
    }
  }
}

function scheduleListen() {
  if (!state.handsFree) return
  setTimeout(() => setListening(true), 350)
}

/* ---------- голос: озвучка ---------- */

function loadVoices() {
  if (!window.speechSynthesis) return
  state.voices = window.speechSynthesis.getVoices()
  const select = el("voiceSelect")
  const current = state.settings.voice
  select.replaceChildren()
  const labels = state.voices
    .filter((voice) => voice.lang.toLowerCase().startsWith("ru") || voice.lang.toLowerCase().startsWith("en"))
    .map((voice) => ({ voice, title: voice.name + " (" + voice.lang + ")" }))
  if (labels.length === 0) {
    const option = document.createElement("option")
    option.value = ""
    option.textContent = "голоса недоступны"
    select.appendChild(option)
    return
  }
  labels.forEach((item) => {
    const option = document.createElement("option")
    option.value = item.voice.name
    option.textContent = item.title
    if (item.voice.name === current) option.selected = true
    select.appendChild(option)
  })
  const russian = labels.find((item) => item.voice.lang.toLowerCase().startsWith("ru"))
  if (current === "" && russian !== undefined) select.value = russian.voice.name
}

function pickVoice() {
  if (state.voices.length === 0) return null
  const wanted = state.settings.voice || el("voiceSelect").value
  if (wanted !== "") {
    const match = state.voices.find((voice) => voice.name === wanted)
    if (match !== undefined) return match
  }
  return state.voices.find((voice) => voice.lang.toLowerCase().startsWith("ru")) || state.voices[0] || null
}

function speak(text) {
  if (!window.speechSynthesis) {
    console.log("[jarvis] speak skipped: no speechSynthesis")
    return
  }
  if (state.recognizing) setListening(false)
  window.speechSynthesis.cancel()
  window.speechSynthesis.resume()
  const utterance = new SpeechSynthesisUtterance(text)
  const voice = pickVoice()
  if (voice !== null) utterance.voice = voice
  utterance.lang = voice !== null ? voice.lang : "ru-RU"
  utterance.rate = 1.12
  utterance.pitch = 0.95
  utterance.volume = 1
  console.log("[jarvis] speak voices=" + state.voices.length + " voice=" + (voice === null ? "default" : voice.name) + " text=" + text.slice(0, 60))
  state.speaking = true
  let finished = false
  const finish = (reason) => {
    if (finished) return
    finished = true
    state.speaking = false
    state.followUpUntil = Date.now() + 12000
    console.log("[jarvis] speak done (" + reason + ")")
    if (state.handsFree) scheduleListen()
  }
  utterance.onstart = () => console.log("[jarvis] speak start")
  utterance.onerror = (event) => {
    console.log("[jarvis] speak error " + event.error)
    finish("error")
  }
  utterance.onend = () => finish("end")
  window.speechSynthesis.speak(utterance)
  // Страховка: в Brave событие end иногда теряется, микрофон не должен залипать.
  const expected = Math.min(20000, Math.max(2500, text.length * 95))
  const watchdog = setInterval(() => {
    if (finished) {
      clearInterval(watchdog)
      return
    }
    if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
      clearInterval(watchdog)
      finish("idle")
    }
  }, 600)
  setTimeout(() => {
    clearInterval(watchdog)
    finish("timeout")
  }, expected * 1.8 + 2500)
}

/* ---------- таймер ---------- */

function startTimer(seconds, label) {
  if (state.timer !== null) clearInterval(state.timer)
  const finish = Date.now() + seconds * 1000
  const chip = el("timerChip")
  chip.hidden = false
  const tick = () => {
    const left = Math.max(0, Math.round((finish - Date.now()) / 1000))
    const minutes = String(Math.floor(left / 60)).padStart(2, "0")
    const rest = String(left % 60).padStart(2, "0")
    chip.textContent = minutes + ":" + rest
    if (left <= 0) {
      clearInterval(state.timer)
      state.timer = null
      chip.hidden = true
      beep()
      const text = (label || "Таймер") + " сработал"
      addMessage("assistant", text)
      if (state.settings.autospeak) speak(text)
    }
  }
  tick()
  state.timer = setInterval(tick, 250)
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = "sine"
    oscillator.frequency.value = 880
    gain.gain.value = 0.12
    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start()
    oscillator.stop(ctx.currentTime + 0.35)
    setTimeout(() => ctx.close(), 700)
  } catch {
    /* звук необязателен */
  }
}

/* ---------- заметки ---------- */

function renderNotes(notes) {
  state.notes = Array.isArray(notes) ? notes : []
  const list = el("notesList")
  list.replaceChildren()
  if (state.notes.length === 0) {
    const empty = document.createElement("li")
    empty.className = "empty"
    empty.textContent = "Пока пусто. Скажи «запомни …» или добавь справа."
    list.appendChild(empty)
    return
  }
  state.notes.forEach((note) => {
    const item = document.createElement("li")
    const text = document.createElement("span")
    text.className = "text"
    text.textContent = note.text
    const when = document.createElement("span")
    when.className = "when"
    const date = new Date(note.ts)
    when.textContent = Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })
    const del = document.createElement("button")
    del.className = "del"
    del.type = "button"
    del.title = "Удалить"
    del.textContent = "×"
    del.onclick = async () => {
      const result = await api("/api/notes?id=" + encodeURIComponent(note.id), undefined, "DELETE")
      renderNotes(result.notes)
    }
    item.append(text, when, del)
    list.appendChild(item)
  })
}

/* ---------- статус и настройки ---------- */

function addModelChip(model) {
  el("modelChip").textContent = model
}

async function refreshStatus() {
  try {
    const data = await api("/api/status")
    const dot = el("statusDot")
    dot.classList.toggle("on", data.online === true)
    dot.classList.toggle("off", data.online !== true)
    el("statusText").textContent = data.online === true
      ? "мозг на связи · freePi"
      : (data.hint || "маршрут freePi недоступен")
    el("apiNote").textContent = data.online === true
      ? "Маршрут: " + data.baseUrl
      : "Запусти Andrey DS Harness и войди в freePi — Джарвис найдёт маршрут сам."
    if (Array.isArray(data.models) && data.models.length > 0) {
      state.models = data.models
      fillModels()
    }
    addModelChip(data.model || state.settings.model || "—")
  } catch (error) {
    el("statusDot").classList.add("off")
    el("statusText").textContent = "сервер не отвечает"
  }
}

function fillModels() {
  const select = el("modelSelect")
  const current = state.settings.model || select.value || ""
  select.replaceChildren()
  state.models.forEach((model) => {
    const option = document.createElement("option")
    option.value = model
    option.textContent = model
    if (model === current) option.selected = true
    select.appendChild(option)
  })
}

async function refreshModels() {
  try {
    const data = await api("/api/models")
    if (Array.isArray(data.models) && data.models.length > 0) {
      state.models = data.models
      fillModels()
    }
  } catch {
    /* останемся на прежнем списке */
  }
}

async function saveSettings() {
  const payload = {
    model: el("modelSelect").value,
    voice: el("voiceSelect").value,
    autospeak: el("autospeak").checked,
    systemPrompt: el("systemPrompt").value,
  }
  const result = await api("/api/settings", payload)
  state.settings = { ...state.settings, ...(result.settings || payload) }
  state.handsFree = el("handsFree").checked
  localStorage.setItem("jarvis-handsfree", state.handsFree ? "1" : "0")
  addMessage("assistant", "Настройки сохранены")
  if (state.handsFree) setListening(true)
  else setListening(false)
}

/* ---------- ввод ---------- */

function resizeInput() {
  const input = el("input")
  input.style.height = "auto"
  input.style.height = Math.min(input.scrollHeight, 160) + "px"
}

/* ---------- старт ---------- */

async function boot() {
  recognition = createRecognition()
  if (SpeechRecognition === undefined) {
    el("micBtn").disabled = true
    el("micBtn").title = "Браузер не поддерживает распознавание речи (нужен Chrome или Edge)"
  }
  if (window.speechSynthesis) {
    loadVoices()
    window.speechSynthesis.onvoiceschanged = loadVoices
  }

  try {
    const data = await api("/api/state")
    state.settings = { ...state.settings, ...(data.settings || {}) }
    renderNotes(data.notes)
    if (data.status?.models) {
      state.models = data.status.models
      fillModels()
    }
    const wantedModel = state.settings.model || data.status?.model || ""
    if (wantedModel !== "") {
      const option = [...el("modelSelect").options].find((item) => item.value === wantedModel)
      if (option !== undefined) el("modelSelect").value = wantedModel
    }
    el("autospeak").checked = state.settings.autospeak !== false
    el("systemPrompt").value = state.settings.systemPrompt || ""
    if (state.settings.voice) setTimeout(() => { el("voiceSelect").value = state.settings.voice }, 200)
  } catch (error) {
    addMessage("assistant", "Сервер не отвечает: " + error.message)
  }

  try {
    const sttInfo = await api("/api/stt/status")
    if (sttInfo.available === true) state.engine = "local"
    console.log("[jarvis] stt engine=" + state.engine + " model=" + (sttInfo.model || "none"))
  } catch {
    state.engine = "web"
  }

  state.handsFree = localStorage.getItem("jarvis-handsfree") !== "0"
  el("handsFree").checked = state.handsFree
  state.noWake = localStorage.getItem("jarvis-nowake") === "1"
  el("noWake").checked = state.noWake

  if (state.handsFree) {
    setListening(true)
    const retry = () => {
      if (state.handsFree && (!state.recognizing || state.micBlocked)) {
        state.micBlocked = false
        setListening(true)
      }
    }
    document.addEventListener("pointerdown", retry)
    document.addEventListener("keydown", retry)
  }
  updateVoiceIndicator()

  if (state.messages.length === 0) {
    addMessage("assistant", "Джарвис на связи. Скажи вслух «Привет, Андрей, который час» или «Джарвис, открой калькулятор» — я слушаю. Можно и текстом.")
  }

  await refreshStatus()
  setInterval(refreshStatus, 25_000)
  el("input").focus()
}

el("composer").addEventListener("submit", (event) => {
  event.preventDefault()
  send(el("input").value)
})

el("input").addEventListener("input", resizeInput)

el("input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    send(el("input").value)
  }
})

el("micBtn").addEventListener("click", () => {
  if (!hasMic()) return
  state.micBlocked = false
  if (state.recognizing) {
    setListening(false)
    return
  }
  setListening(true)
})

el("testVoice").addEventListener("click", () => {
  console.log("[jarvis] test voice clicked, synth=" + (typeof window.speechSynthesis) + " voices=" + state.voices.length)
  speak("Привет, Андрей. Это проверка голоса.")
})

el("micGate").addEventListener("click", () => {
  state.micBlocked = false
  setListening(true)
  updateVoiceIndicator()
})

el("stopBtn").addEventListener("click", stopAll)

el("noteForm").addEventListener("submit", async (event) => {
  event.preventDefault()
  const text = el("noteInput").value.trim()
  if (text === "") return
  el("noteInput").value = ""
  const result = await api("/api/notes", { text })
  renderNotes(result.notes)
})

el("notesClear").addEventListener("click", async () => {
  const result = await api("/api/notes/clear", {})
  renderNotes(result.notes)
})

el("reloadModels").addEventListener("click", refreshModels)
el("saveSettings").addEventListener("click", () => { saveSettings().catch((error) => addMessage("assistant", "Не сохранилось: " + error.message)) })

el("noWake").addEventListener("change", () => {
  state.noWake = el("noWake").checked
  localStorage.setItem("jarvis-nowake", state.noWake ? "1" : "0")
  console.log("[jarvis] noWake=" + state.noWake)
})

el("handsFree").addEventListener("change", () => {
  state.handsFree = el("handsFree").checked
  localStorage.setItem("jarvis-handsfree", state.handsFree ? "1" : "0")
  updateVoiceIndicator()
  if (state.handsFree) {
    state.micBlocked = false
    setListening(true)
  } else {
    setListening(false)
  }
})

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") stopAll()
  if (event.ctrlKey && (event.key === "m" || event.key === "ь")) {
    event.preventDefault()
    if (recognition === null) return
    setListening(!state.recognizing)
  }
})

boot().catch((error) => {
  addMessage("assistant", "Не удалось запуститься: " + error.message)
})
