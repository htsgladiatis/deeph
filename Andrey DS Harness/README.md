# Andrey DS Harness V 0.4

Копия DeepSeek Harness с собственным слоем `lib/andrey` (загружается через
`resources/app/package.json` → `main: lib/andrey/boot.cjs`). Правки в этом каталоге
применяются сразу: `resources/app` распакован, asar пересобирать не нужно — только
перезапустить приложение.

## Дизайн

Пункт **«Дизайн»** в меню «…» (и `Ctrl+Shift+D`) открывает полноэкранный редактор
канваса: прямоугольники, эллипсы, текст, перо, выделение, перемещение, ресайз,
цвета, слои, undo/redo, несколько документов и автосохранение.

- Горячие клавиши: `V` выделение, `H` рука, `R` прямоугольник, `O` эллипс, `T` текст,
  `P` перо; `Space` + перетаскивание — панорама; колесо — зум к курсору;
  `Delete` удалить, `Ctrl+D` дублировать, `Ctrl+Z` / `Ctrl+Shift+Z` отмена/повтор,
  `Ctrl+S` сохранить, `Esc` закрыть панель.
- Документ: `~/.config` не используется — файлы в `%APPDATA%\andrey-ds-harness\design\<id>.json`
  (переопределяется `ANDREY_DATA_ROOT`). Хранится до 50 документов, запись атомарная.
- Модель для ИИ берётся из текущего выбора в чате; если имя неоднозначно (есть у обоих
  провайдеров), в селекте панели показывается суффикс провайдера.

### API (только loopback)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/design/docs` | список документов |
| GET | `/design/state?id=main` | документ |
| POST | `/design/state` | сохранить `{id, doc}` |
| POST | `/design/docs` | `create` / `rename` / `delete` |
| GET | `/design/models` | каталог моделей из профиля |
| POST | `/design/ai` | `{model, provider?, prompt, doc}` → `{ops, rejected}` |

Провайдер для `/design/ai` определяется по списку моделей профиля
(`dsh-home/profiles/desktop/cordis.patch.yml`): имя из `freepi` идёт в
`/freepi/v1/chat/completions`, из `freebuff` — в `/v1/chat/completions`. Токены и
устройство остаются внутри процесса: запросы уходят на собственный loopback-маршрут,
а не наружу.

Лог: `%APPDATA%\andrey-ds-harness\freebuff-route.log` (`design:save`, `design:ai`).

### Файлы

- `lib/andrey/design/ops.js` — схема документа и валидация (браузерная сборка).
- `lib/andrey/design/ops.cjs` — та же логика для Node.
- `lib/andrey/design/canvas.js` — движок канваса (рендер, ввод, история).
- `lib/andrey/design/panel.js` — панель, свойства, слои, документы, ИИ.
- `lib/andrey/design/panel.css` — стили (все классы `adz-`).
- `lib/andrey/ui-inject.cjs` — инжектит `panel.css`, затем `ops.js → canvas.js → panel.js → ui-renderer.js`.
- `lib/andrey/freebuff-route.cjs` — эндпоинты `/design/*`.

Все скрипты — обычные (без `import`/`export`), общаются через `window.AndreyDesign`.
## Пэт

В правом нижнем углу окна живёт «сгусток точек»: он показывает, чем занят агент, и
молчит, когда всё тихо. Состояния: `idle` — дышит, `working` — ускоренно вращается,
`replying` — пульсирует волной, `waiting` — тревожно мигает, `celebrate` / `error` —
короткие всплески. Состояние выводится из запросов страницы к LLM-маршрутам и лёгкого
опроса DOM; без сигналов пэт остаётся в `idle`.

- Пункт **«Скрыть пэта» / «Показать пэта»** в меню «…» — включение и выключение,
  выбор запоминается (`andrey-pet-enabled`).
- Перетаскивание — своя позиция (`andrey-pet-pos`), двойной клик — вернуть в угол,
  клик или Enter — короткая реакция и бабл со статусом.
- Файл: `lib/andrey/pet.js`, вставляется `ui-inject.cjs` вместе с `ui-renderer.js`.
