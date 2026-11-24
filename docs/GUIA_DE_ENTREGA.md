# VORAEL — Guía completa de uso y entrega

> **Para quién es:** cualquier persona que tenga el repositorio en su máquina y
> quiera ver VORAEL funcionando, probar todas sus funciones y entender qué está
> pasando, **sin conocer el proyecto** y sin llamar al autor.
>
> **Tiempo estimado:** 5 minutos para arrancarlo, 10 minutos para recorrerlo,
> 15 minutos para leer el guion de clase del final.
>
> Producción: <https://n8n.americana.edu.co/vorael/>
> Código: <https://github.com/SenzaNomeca/Buscador-IA-con-grafos>

---

## 1. Qué es VORAEL (en 30 segundos)

VORAEL es un **catálogo web de solo lectura** de imágenes generadas por IA de la
Corporación Universitaria Americana. No genera imágenes: un flujo externo de
**n8n** las crea, las sube a DigitalOcean Spaces y escribe sus metadatos en
PostgreSQL. VORAEL las muestra, las busca, las relaciona y permite descargarlas.

Se compone de:

- **Web** (`apps/web`): SPA de React + Vite bajo la sub-ruta `/vorael/`.
- **API** (`apps/api`): Express + TypeScript, sirve datos en `/api/...`.
- **Grafo en memoria** (Graphology): índice de imágenes y metadatos; se
  actualiza sin reiniciar.
- **Volcado local** (`apps/api/data/images.json`): copia del catálogo público
  que la API descarga sola al arrancar y **cada 60 segundos**. No está en Git
  porque pesa ~118 MB y se regenera automáticamente.

---

## 2. Arrancar desde cero (sin credenciales)

### Requisitos

- Node.js **≥ 20**
- pnpm **11.3.0** (`corepack enable` o instalar desde npm)

### Pasos

```bash
# 1. Dependencias (desde la raíz del repo)
pnpm install

# 2. Configuración local (modo mock + volcado automático)
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

En PowerShell de Windows:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/web/.env.example apps/web/.env
```

El `.env.example` del API ya viene con esto activo:

```dotenv
DB_MOCK=true                    # no necesita PostgreSQL ni credenciales S3
DB_FILE=data/images.json        # el catálogo se lee del volcado local
AUTO_SYNC_MS=60000              # vuelco inicial + cada 60 s
AUTO_SYNC_ON_BOOT=true
```

```bash
# 3. Arrancar API (puerto 3001) y web (puerto 5173)
pnpm dev
```

Abrir **<http://localhost:5173/vorael/>** (la barra final importa: es la
`base` de Vite).

> **No hace falta Docker ni base de datos** para esta demostración. Docker y
> PostgreSQL real solo se usan para desarrollo con la BD local (`pnpm seed:db`).

### Qué debe pasar en la consola del API

Al arrancar verás, en este orden:

```
[sync] boot …                       → descarga el catálogo desde producción
[sync] full — +N filas …            → escribe apps/api/data/images.json
[graph] loaded N images, … nodes    → construye el grafo con esas filas
[sync] auto-sync cada 60000ms       → queda el timer activo
```

El primer vuelco completo recorre el catálogo en páginas de 100 imágenes; con
el catálogo actual tarda **menos de un minuto**. Mientras tanto la galería
estará vacía (decisión deliberada: mejor vacío y avisar en logs que mostrar
datos falsos). En cuanto termina, aparece sola: **no hay que reiniciar**.

Si no hay internet, verás un `warn` de sync cada 60 s y la galería seguirá
vacía. Cuando vuelva la red, el siguiente tick la llena.

---

## 3. Recorrido por la interfaz (qué probar y qué significa)

### 3.1 Galería — `/vorael/`

- Grid de imágenes ordenadas de más nueva a más vieja, **24 por página**.
- Baja al final: carga la siguiente página sola (**scroll infinito**).
- Botón **Filtros**: estilo artístico, mood (estado emocional) y caso de uso,
  con el conteo de imágenes de cada valor. Puedes combinar varios.
- Click en una imagen → detalle (§3.4).

### 3.2 Buscador — barra superior

Escribe y espera **300 ms** (debounce): la URL cambia a
`/vorael/search?q=...` automáticamente. Busca en **tags, sujeto, estilo, mood,
caso de uso y prompts**. Prueba estas consultas:

| Consulta | Qué demuestra |
|---|---|
| `gato` | Coincidencia directa por tag/sujeto. |
| `sonriendo` | El sinónimo curado encuentra `sonrisa`/`sonriente`. |
| `oficina` | Encuentra `escritorio` y `office` (sinónimos). |
| `gato naranja` | Varios términos: exige cohesión para el tramo alto. |
| `dibujo animado de un gato` | Frase larga: stopwords se ignoran; el % mide cobertura. |

En la página de resultados verás **tres bloques**:

| Bloque | % | Cómo leerlo |
|---|---|---|
| **Resultados parecidos** | 80–100 | Todas las palabras del query aparecen en metadatos curados y juntas de forma coherente. |
| **Podría encajar** | 40–79 | Coincidencia parcial pero con algún término distintivo. |
| **Podrían ser similares** | 10–39 | Aproximación débil; útil para explorar. |

Cada bloque tiene su propio botón **“Ver más”** y su paginación independiente.

> El **% no es una probabilidad** ni “calidad”: es cobertura ponderada de
> metadatos. Un término raro pesa más que uno común (`gato` pesa más que
> `persona`). Pesos: tag `1.00`, token de tag `0.95`, sujeto `0.90`,
> estilo/mood/uso `0.85`, prompt original `0.65`, prompt mejorado `0.60`.

### 3.3 Modos de búsqueda y subgrafo

En la parte superior de `/search?q=...` hay chips:

- **Léxica** — coincidencia por palabras (minúsculas, sin tildes, plurales,
  sinónimos). Funciona siempre, sin servicios externos.
- **Semántica** — similitud por significado (embeddings `bge-m3` con Ollama).
  Encuentra `felino` cuando buscas `gato`. Requiere Ollama y la tabla
  `image_embeddings`; si faltan, **degrada a léxica sin error**.
- **Híbrida** — une ambas señales; el % final es
  `max(coincidencia de metadatos, coseno × 100)`.
- **Ver grafo** — dibuja el subgrafo del **top 100** de esa búsqueda: nodos de
  imagen + metadatos que comparten al menos 2 imágenes del resultado. Vuelve a
  los resultados con **“Ver resultados”**.

También puedes fijar el modo en la URL:

```
/vorael/search?q=gato&mode=lexical
/vorael/search?q=gato&mode=semantic
/vorael/search?q=gato&mode=hybrid
```

El modo por defecto lo publica el servidor en `/api/health` (`search.mode`).

### 3.4 Detalle de imagen — `/vorael/image/<id>`

Muestra imagen ampliada, sujeto, fecha, prompts original y mejorado, paleta de
colores, tags (clicables → página del tag) y la sección **Relacionadas** (hasta
8 imágenes por similitud de metadatos).

**Descarga:** el botón dice `Descargar WebP` por defecto; la flecha de al lado
abre el selector **WebP / PNG / JPG**. El archivo se convierte al vuelo con
Sharp y se entrega como adjunto. Si el servidor tiene `METADATA_EMBED=exiftool`,
lleva incrustados descripción, autoría, keywords y el namespace propio
`XMP-vorael:*`. Sin exiftool, se descarga igual pero sin metadatos.

### 3.5 Tags — `/vorael/tags` y `/vorael/tag/<tag>`

Nube de etiquetas ordenada por frecuencia. Al elegir una se muestra su grid con
scroll infinito.

### 3.6 Stats — `/vorael/stats`

Totales del catálogo, top 10 de estilos, top 10 de moods y top 20 de tags.

### 3.7 Red — `/vorael/graph`

- **Atlas de grupos**: cada burbuja es una comunidad detectada con Louvain
  (imágenes que comparten muchos metadatos). El tamaño = cantidad de imágenes.
- Click en una burbuja o en la leyenda → **Imágenes** del grupo, unidas por los
  metadatos compartidos. **Volver al atlas** regresa.
- Click en un nodo abre un panel con su información; los nodos de imagen
  navegan al detalle y los de tag/styles abren su filtro.
- Botón **Imágenes**: muestra una muestra general, no solo un grupo.

El render usado es **vis-network** (física Barnes-Hut y resaltado de vecinos).

---

## 4. Cómo se mantiene el catálogo (volcado automático)

Es el punto que más confunde, así que va explicado paso a paso:

1. Al arrancar, si hay `DB_FILE`, el API **espera a volcar** el catálogo desde
   `https://n8n.americana.edu.co/vorael/api/images` antes de construir el grafo.
2. Cada **60 s** repite un sync **incremental**: pide las páginas nuevas hasta
   encontrar 2 páginas seguidas de ids ya conocidos (~12 peticiones, no 630).
3. El JSON se reemplaza de forma **atómica** (tmp + rename). La API lo detecta
   por `mtime:size` y el grafo absorbe las filas nuevas en su siguiente tick.
4. Se fuerza un volcado **completo** si:
   - no existe el archivo o está corrupto;
   - faltan filas viejas;
   - **el remoto tiene menos imágenes que el local** (reinicio de la base o
     bajas) → se reconcilia y se recarga el grafo de inmediato;
   - pasan 7 días (`SYNC_FULL_MS`) como reconciliación de seguridad.
5. Si el sync falla, se conserva el volcado anterior, se avisa en logs y se
   reintenta en 60 s. **No se sustituye por imágenes mock**.

Comandos relacionados:

```bash
pnpm dump:prod     # volcado completo manual (una vez)
pnpm dump:sync     # sync incremental manual
DUMP_FULL=true pnpm dump:sync   # forzar reconciliación completa
```

El archivo vive en `apps/api/data/images.json` y está en `.gitignore`:
**no se sube a GitHub**. Cualquier máquina que clone el repo lo regenera sola.

---

## 5. Comprobar que todo funciona

```bash
pnpm test          # 204 pruebas (Vitest + Supertest), sin DB ni S3
pnpm build         # compila API y web
pnpm lint          # ESLint de ambos paquetes
```

Comprobaciones en vivo:

```bash
curl http://localhost:3001/api/health
curl "http://localhost:3001/api/images?limit=1"
curl "http://localhost:3001/api/search?q=gato&grouped=1"
curl "http://localhost:3001/api/graph?mode=atlas&limit=5"
```

`GET /api/health` devuelve algo así:

```json
{
  "ok": true,
  "ts": "2026-11-24T14:00:00.000Z",
  "graph": { "rows": 12000, "nodes": 2400, "edges": 5600,
             "builtAt": "...", "buildMs": 1800 },
  "search": { "mode": "lexical", "model": "bge-m3" }
}
```

Si `graph` es `null`, el grafo aún no ha terminado de cargar.

---

## 6. API REST (referencia rápida)

Todas son **GET** y de solo lectura, bajo `/api/` en dev y `/vorael/api/` en
producción.

| Ruta | Parámetros | Respuesta |
|---|---|---|
| `/api/health` | — | Estado, métricas del grafo y modo de búsqueda |
| `/api/images` | `page`, `limit`≤100, `style`, `mood`, `use_case` | `{ items, page, limit, total, hasMore }` |
| `/api/images/:id` | — | Imagen completa |
| `/api/images/:id/download` | `format=webp\|png\|jpg` | Binario con `Content-Disposition` |
| `/api/images/:id/related` | `limit`≤24 | `{ items }` |
| `/api/search` | `q`, `page`, `limit`, `mode`, `grouped=1`, `tier=strong\|possible\|loose`, `graph=1` | `{ tiers[], ... }` o `{ items[], ... }` |
| `/api/tags` | `limit`≤500 | `{ items }` |
| `/api/tags/:tag/images` | `page`, `limit` | `{ items, ... }` |
| `/api/filters` | — | `{ styles, moods, useCases }` |
| `/api/stats` | — | `{ total, topStyles, topMoods, topTags }` |
| `/api/graph` | `types`, `limit`≤600, `center`, `hops`, `ids`, `mode=atlas\|images\|bipartite`, `community` | `{ nodes, edges }` |

Los parámetros inválidos se corrigen, no devuelven 400.

---

## 7. Solución de problemas

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Galería vacía al arrancar | Primer volcado todavía en curso | Esperar; mirar logs `[sync]`. No reiniciar. |
| Vacía y logs de error cada 60 s | Sin internet hacia la API pública | Conectar red; el siguiente tick la llena. |
| Imágenes no se ven (pero hay texto) | El volcado trae URLs `https://…` de Spaces y no hay red | Conectar red; los metadatos sí están cargados. |
| `/vorael` da 404 | Falta la barra final | Abrir `/vorael/`. |
| La búsqueda devuelve 0 | Término muy específico o modo semántico sin embeddings | Probar `gato`, cambiar a **Léxica**. |
| Modo Semántica no mejora | No hay Ollama o `image_embeddings` vacía | Degrada a léxica; ver `[api/health]` → `search.mode`. |
| Descarga sin metadatos | `METADATA_EMBED=none` o falta exiftool | Es degradación silenciosa; el archivo se entrega igual. |
| Grafo vacío en una búsqueda | Los resultados no comparten suficientes metadatos | Probar otra query o usar `/vorael/graph`. |
| `pnpm` no existe | Versión/instalación | Usar pnpm 11.3.0 (`corepack enable`). |

---

## 8. Guion para clase (5 minutos, sin sustentación en vivo)

Abre esta guía en una pestaña y el proyecto en otra. Di/ejecuta esto:

1. **(30 s) Qué es.** “Es un catálogo de imágenes IA de la Americana. No genera
   imágenes: solo lee lo que produce n8n y lo hace buscable y descargable.”
2. **(60 s) Arranca.** Muestra `pnpm install`, `.env.example` → `.env`,
   `pnpm dev`, y abre `http://localhost:5173/vorael/`.
3. **(60 s) Galería y filtros.** Baja (scroll infinito), abre Filtros, elige un
   estilo. “24 por página, sin recargar.”
4. **(90 s) Búsqueda.** Escribe `sonriendo`. Muestra los tres tramos y el %:
   “no es probabilidad: es cuánto del query aparece en metadatos; `sonriendo`
   encuentra `sonrisa` por sinónimos.” Cambia a **Léxica**, luego a **Híbrida**.
5. **(60 s) Grafo.** Pulsa **Ver grafo**: “subgrafo del top 100; cada nodo de
   metadato conecta imágenes que lo comparten”. Luego abre `/vorael/graph`,
   entra a una burbuja del atlas y vuelve.
6. **(60 s) Detalle y descarga.** Abre una imagen, muestra prompts/paleta,
   descarga WebP y cambia a PNG.
7. **(30 s) Mantenimiento.** Muestra el log `[sync] auto-sync cada 60000ms` y
   explica: “el catálogo se vuelve solo; si producción borra imágenes, el
   siguiente full las quita de aquí también”.
8. **(30 s) Cierre.** `pnpm test`: “204 pruebas, sin base ni S3”.

### Preguntas probables y respuesta corta

- **¿Por qué un % y no un ranking normal?** Porque el profesor/usuario necesita
  saber *por qué* apareció: el % es cobertura de metadatos explicable, con
  pesos por campo.
- **¿Por qué un grafo?** Permite relacionar imágenes por metadatos compartidos
  y mostrar temáticas del catálogo sin conocer las etiquetas.
- **¿Qué pasa si se cae PostgreSQL/Ollama/ExifTool?** El grafo conserva el
  último snapshot, la búsqueda cae a léxica y las descargas siguen sin
  metadatos. Ningún caso rompe la web.
- **¿Quién sube las imágenes?** n8n, fuera de este repo. VORAEL nunca escribe.
- **¿Por qué no está el catálogo en GitHub?** Es un volcado regenerable de
  ~118 MB; el repo arranca vacío y se llena solo en el primer arranque.
- **¿Es escalable?** El grafo vive en memoria: cómodo hasta ~50–100 k imágenes;
  deltas cada minuto y full cada 10 min evitan recargar todo.

---

## 9. Mapa de documentación

| Documento | Para qué sirve |
|---|---|
| [README.md](../README.md) | Entrada rápida, stack, comandos. |
| **Esta guía** | Arrancar, usar y demostrar VORAEL. |
| [MVP.md](../MVP.md) | Alcance, casos de uso, requisitos y roadmap. |
| [ARQUITECTURA.md](../ARQUITECTURA.md) | Detalle técnico: grafo, rutas, variables, sync. |
| [CHEATSHEET.md](CHEATSHEET.md) | Mapa rápido del código y del API. |
| [DEPLOY.md](../DEPLOY.md) | Despliegue en el servidor (Nginx + systemd). |
| [GUIA_EMBEDDINGS.md](GUIA_EMBEDDINGS.md) | Contexto histórico de búsqueda semántica. |
| [vorael-slides.html](vorael-slides.html) | Diapositivas autocontenidas para presentar. |
