# Poner en marcha el guardado compartido (gratis, sin servidor propio)

## 1. Crear el Worker
1. Entrá a https://dash.cloudflare.com y creá una cuenta gratis (si no tenés).
2. En el menú lateral: **Workers & Pages** (o **Compute (Workers)** según la cuenta) → **Create application** → **Start with Hello World!** → **Get started**.
3. Ponele un nombre, por ejemplo `asistencias-wspd`. Click en **Deploy**.
4. Ya desplegado, click en **Edit code**, borrá todo el contenido de ejemplo, y pegá el contenido de `worker.js`.
5. Click en **Deploy** de nuevo para guardar tu código.

## 2. Crear el almacenamiento (KV) — aparte del Worker
1. En el menú lateral del dashboard: **Storage & Databases** → **KV** (a veces aparece como **Workers KV**).
2. Click en **Create instance** (o **Create namespace**).
3. Ponele un nombre, por ejemplo `asistencias_kv`. Click en **Create**.

## 3. Conectar el KV con el Worker (binding)
1. Volvé a tu Worker (`asistencias-wspd`) → pestaña **Settings** → **Bindings**.
2. Click en **Add** → elegí **KV namespace**.
3. En **Variable name** escribí exactamente: `ASISTENCIAS_KV` (el código de `worker.js` usa ese nombre tal cual, es case-sensitive).
4. En **KV namespace** elegí el que creaste en el paso 2 (`asistencias_kv`).
5. Guardá — puede pedirte **Deploy** de nuevo para que el binding quede activo.

## 4. Copiar la URL del Worker
Arriba, en la página de tu Worker, vas a ver algo como:
`https://asistencias-wspd.tu-usuario.workers.dev`

Copiá esa URL completa.

## 5. Conectar la página
Abrí `asistencias.html`, buscá esta línea cerca del principio del `<script>`:

```js
const API_URL = "PEGA_AQUI_LA_URL_DE_TU_WORKER";
```

Reemplazala por tu URL real, subí el archivo a tu repo de GitHub Pages, y listo:
la primera persona que abra la página va a sembrar el servidor con la lista base
automáticamente, y desde ahí todos los registros nuevos se guardan y se ven
para cualquiera que abra la página, sin importar el dispositivo.

## Notas
- Es gratis hasta un uso bastante alto (100,000 lecturas/día en el plan free de Cloudflare KV), de sobra para esto.
- `ALLOWED_ORIGIN = "*"` en `worker.js` deja que cualquier sitio le pegue a tu Worker. Si querés cerrarlo solo a tu página, cambialo por tu dominio real de GitHub Pages, ej `"https://tuusuario.github.io"`.
- No hace falta HTTPS aparte ni certificados: los Workers ya sirven en `https://` por defecto, así que no hay problema de "contenido mixto" con GitHub Pages.
- Si el panel te muestra otros nombres de menú (Cloudflare va cambiando la interfaz seguido), buscá algo equivalente a "Bindings" dentro de tu Worker y "KV" dentro de Storage — la idea siempre es: 1) namespace de KV creado, 2) atado al Worker con el variable name `ASISTENCIAS_KV`.
