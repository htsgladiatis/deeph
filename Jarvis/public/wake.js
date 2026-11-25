/* Слова-обращения к Джарвису: вынесено отдельно, чтобы это можно было тестировать без браузера. */
(function (root) {
  var WAKE_NAMES = ["джарвис", "jarvis", "андрей", "андрэй"]
  var WAKE_GREETINGS = ["привет", "здравствуй", "здравствуйте", "хай", "приветствую"]

  function bare(word) {
    return String(word).replace(/[,.!?:;\-]+$/g, "")
  }

  /** Возвращает { greeting, rest } без слова-обращения или null, если к Джарвису не обращались. */
  function stripWake(phrase) {
    var clean = String(phrase || "").replace(/[«»"]/g, " ").replace(/\s+/g, " ").trim()
    if (clean === "") return null
    var words = clean.toLowerCase().split(" ")
    var isName = function (word) { return WAKE_NAMES.indexOf(bare(word)) !== -1 }
    var isGreeting = function (word) { return WAKE_GREETINGS.indexOf(bare(word)) !== -1 }
    if (words.length >= 2 && isGreeting(words[0]) && isName(words[1])) {
      return { greeting: true, rest: words.slice(2).join(" ").replace(/^[\s,.!?:;\-]+/, "").trim() }
    }
    if (isName(words[0])) {
      return { greeting: false, rest: words.slice(1).join(" ").replace(/^[\s,.!?:;\-]+/, "").trim() }
    }
    var inlineRegex = /(^|[^а-яёa-z0-9])(?:джарвис|jarvis)(?![а-яёa-z0-9])/gi
    var inline = clean.replace(inlineRegex, "$1 ").replace(/\s+/g, " ").trim()
    if (inline !== clean) {
      return { greeting: false, rest: inline.replace(/^[\s,.!?:;\-]+/, "").trim() }
    }
    return null
  }

  root.JarvisWake = {
    stripWake: stripWake,
    names: WAKE_NAMES,
    greetings: WAKE_GREETINGS,
  }
})(typeof window !== "undefined" ? window : globalThis)