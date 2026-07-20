// Worker de Cloudflare para guardar la lista de asistencias Y la lista de
// evaluaciones, compartidas entre todos. No requiere servidor propio: se
// despliega gratis en Cloudflare.
//
// Recurso "asistencias" (comportamiento de siempre, sin cambios de URL):
//   GET  /                        -> { asistencias: [...], ultimaActualizacion }
//   POST / { entries: [...] }     -> agrega puntos
//   POST / { edit: {...} }        -> edita/renombra a una persona
//   POST / { delete: {...} }      -> elimina a una persona
//
// Recurso "evaluaciones" (nuevo):
//   GET  /?recurso=evaluaciones                    -> { evaluaciones: [...], ultimaActualizacion }
//   POST / { recurso:"evaluaciones", guardar: {...} }   -> crea o edita (cada guardado = un intento)
//   POST / { recurso:"evaluaciones", eliminar: {...} }  -> elimina el registro de evaluación

const KV_KEY_ASISTENCIAS = "asistencias";
const KV_KEY_EVALUACIONES = "evaluaciones";

// Por seguridad, cambiá esto por tu dominio real de GitHub Pages una vez
// que lo tengas andando, ej: "https://tuusuario.github.io"
const ALLOWED_ORIGIN = "*";

function withCors(resp) {
  resp.headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return resp;
}

function json(data, status = 200) {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function limpiarRegistro(r) {
  return {
    tipo: r && r.tipo === "amarillo" ? "amarillo" : "verde",
    fecha: (r && r.fecha) || "—",
    turno: (r && r.turno) || "—",
    instructor: (r && r.instructor) || "—",
    registrador: (r && r.registrador) || "Desconocido",
  };
}

// ==================== helpers genéricos de KV ====================
// Cargan/guardan { lista: [...], ultimaActualizacion } bajo una key dada,
// tolerando: valor vacío, formato viejo (array pelado), o JSON corrupto.
async function cargarLista(env, kvKey, campoLista) {
  const raw = await env.ASISTENCIAS_KV.get(kvKey);
  if (!raw) return { lista: [], ultimaActualizacion: null };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { lista: [], ultimaActualizacion: null };
  }

  let lista = [];
  let ultimaActualizacion = null;

  if (Array.isArray(parsed)) {
    lista = parsed; // formato viejo: array pelado
  } else if (parsed && Array.isArray(parsed[campoLista])) {
    lista = parsed[campoLista];
    ultimaActualizacion = parsed.ultimaActualizacion || null;
  }

  lista = lista.filter((p) => p && typeof p.nombre === "string" && p.nombre.trim());

  return { lista, ultimaActualizacion };
}

async function guardarLista(env, kvKey, campoLista, lista) {
  const estado = {
    [campoLista]: lista,
    ultimaActualizacion: new Date().toISOString(),
  };
  await env.ASISTENCIAS_KV.put(kvKey, JSON.stringify(estado));
  return estado;
}

// ==================== evaluaciones ====================
function limpiarEvaluacion(nombre, e) {
  return {
    nombre,
    resultado: e && e.resultado === "reprobado" ? "reprobado" : "aprobado",
    fecha: (e && e.fecha) || "—",
    evaluador: (e && e.evaluador) || "—",
    observaciones: (e && e.observaciones) || "",
  };
}

async function manejarEvaluaciones(request, env, payload) {
  if (request.method === "GET") {
    const { lista, ultimaActualizacion } = await cargarLista(env, KV_KEY_EVALUACIONES, "evaluaciones");
    return json({ evaluaciones: lista, ultimaActualizacion });
  }

  const { lista: evaluaciones } = await cargarLista(env, KV_KEY_EVALUACIONES, "evaluaciones");

  // ---- crear o editar (cada guardado cuenta como un intento) ----
  if (payload.guardar && payload.guardar.nombre) {
    const nombreLimpio = String(payload.guardar.nombre).trim();
    const datos = limpiarEvaluacion(nombreLimpio, payload.guardar);

    let registro = evaluaciones.find(
      (ev) => ev.nombre.toLowerCase() === nombreLimpio.toLowerCase()
    );
    const intento = { fecha: datos.fecha, resultado: datos.resultado, evaluador: datos.evaluador };

    if (!registro) {
      registro = { ...datos, historial: [intento] };
      evaluaciones.push(registro);
    } else {
      registro.resultado = datos.resultado;
      registro.fecha = datos.fecha;
      registro.evaluador = datos.evaluador;
      registro.observaciones = datos.observaciones;
      if (!Array.isArray(registro.historial)) registro.historial = [];
      registro.historial.push(intento);
    }

    const estado = await guardarLista(env, KV_KEY_EVALUACIONES, "evaluaciones", evaluaciones);
    return json({ evaluaciones: estado.evaluaciones, ultimaActualizacion: estado.ultimaActualizacion });
  }

  // ---- eliminar ----
  if (payload.eliminar && payload.eliminar.nombre) {
    const nombreLimpio = String(payload.eliminar.nombre).trim().toLowerCase();
    const idx = evaluaciones.findIndex((ev) => ev.nombre.toLowerCase() === nombreLimpio);
    if (idx !== -1) {
      evaluaciones.splice(idx, 1);
      const estado = await guardarLista(env, KV_KEY_EVALUACIONES, "evaluaciones", evaluaciones);
      return json({ evaluaciones: estado.evaluaciones, ultimaActualizacion: estado.ultimaActualizacion });
    }
    const actual = await cargarLista(env, KV_KEY_EVALUACIONES, "evaluaciones");
    return json({ evaluaciones: actual.lista, ultimaActualizacion: actual.ultimaActualizacion });
  }

  return json({ error: "Acción de evaluaciones no reconocida" }, 400);
}

// ==================== escalafón (tenientes, capitanes, ...) ====================
// "tenientes" reutiliza la misma KV key que ya usaba "evaluaciones" (no se
// migran datos: la lista de evaluaciones actual ES la lista de tenientes).
// Cada persona: { nombre, resultado, fecha, evaluador, observaciones, historial: [...] }
// resultado = estado del ÚLTIMO intento en ESTA lista ('aprobado' | 'reprobado' | null = sin evaluar).
// historial = TODA la carrera (todos los rangos), no se reinicia nunca.
//
// Regla de ascenso automático: al agregar un intento (agregarIntento), la
// persona SIEMPRE pasa a la siguiente lista, sea aprobada o reprobada, y se
// elimina de la lista en la que estaba — siempre que exista un escalón
// siguiente ya armado. Capitanes es el tope actual (no existe "mayores"
// todavía), así que ahí el registro se queda con el resultado actualizado,
// permitiendo reintentos ("Agregar Intento") hasta que se apruebe.
const RANGO_LABEL = {
  tenientes: "Teniente",
  capitanes: "Capitán",
  mayores: "Mayor",
};

const ESCALAFON_CONFIG = {
  tenientes: { kvKey: "evaluaciones", siguiente: "capitanes" },
  capitanes: { kvKey: "capitanes", siguiente: "mayores" },
  // mayores: se agrega cuando exista ese escalón (Mayor es el techo por ahora)
};

function limpiarIntentoEscalafon(nombre, e) {
  return {
    nombre,
    resultado: e && e.resultado === "reprobado" ? "reprobado" : "aprobado",
    fecha: (e && e.fecha) || "—",
    evaluador: (e && e.evaluador) || "—",
    observaciones: (e && e.observaciones) || "",
  };
}

async function manejarEscalafon(request, env, payload, recurso) {
  const config = ESCALAFON_CONFIG[recurso];
  if (!config) return json({ error: `Recurso "${recurso}" no reconocido` }, 400);

  if (request.method === "GET") {
    const { lista, ultimaActualizacion } = await cargarLista(env, config.kvKey, recurso);
    return json({ [recurso]: lista, ultimaActualizacion });
  }

  const { lista } = await cargarLista(env, config.kvKey, recurso);

  // ---- agregar intento: evalúa (aprobado/reprobado), actualiza el estado
  // actual y suma una entrada al historial de carrera.
  //
  // Regla nueva: la evaluación SIEMPRE hace avanzar a la persona a la
  // siguiente lista, sea aprobada o reprobada, y se elimina de la lista en
  // la que estaba. Si todavía no existe un escalón siguiente armado (por
  // ahora, Capitanes es el techo: "mayores" no está construido), el
  // registro se queda en esta lista con el resultado actualizado — así el
  // botón "Agregar Intento" puede volver a usarse para reintentar. ----
  if (payload.agregarIntento && payload.agregarIntento.nombre) {
    const nombreLimpio = String(payload.agregarIntento.nombre).trim();
    const datos = limpiarIntentoEscalafon(nombreLimpio, payload.agregarIntento);
    const transicion = `Evaluación de ${RANGO_LABEL[recurso] || recurso}`;

    const idx = lista.findIndex((p) => p.nombre.toLowerCase() === nombreLimpio.toLowerCase());
    const historialPrevio = idx !== -1 && Array.isArray(lista[idx].historial) ? lista[idx].historial : [];
    const intento = { fecha: datos.fecha, resultado: datos.resultado, evaluador: datos.evaluador, observaciones: datos.observaciones, transicion };
    const historialNuevo = [...historialPrevio, intento];

    // El resultado de esta evaluación ES el estado del rango de ESTA lista
    // (por ejemplo: evaluar en Asistencias es evaluar para Teniente, por eso
    // se manda para allá). No queda "pendiente": apruebe o repruebe, ese es
    // el estado real acá.
    const personaActualizada = {
      nombre: datos.nombre,
      resultado: datos.resultado,
      fecha: datos.fecha,
      evaluador: datos.evaluador,
      observaciones: datos.observaciones,
      historial: historialNuevo,
    };

    // soloRegistrar = true: esta llamada solo actualiza/ingresa el registro
    // EN ESTA lista (ingreso desde la lista anterior, o reintento de la
    // evaluación de este mismo rango). No ascciende de largo hacia el
    // siguiente escalón.
    if (payload.agregarIntento.soloRegistrar === true) {
      if (idx !== -1) lista[idx] = personaActualizada; else lista.push(personaActualizada);
      const estado = await guardarLista(env, config.kvKey, recurso, lista);
      return json({ [recurso]: estado[recurso], ultimaActualizacion: estado.ultimaActualizacion });
    }

    // Evaluación para el SIGUIENTE rango (por ejemplo, evaluar a un Teniente
    // para Capitán): siempre avanza, apruebe o repruebe, y ese resultado
    // queda tal cual como estado del rango en la lista destino.
    const siguienteRecurso = config.siguiente;
    const siguienteConfig = siguienteRecurso ? ESCALAFON_CONFIG[siguienteRecurso] : null;

    if (siguienteConfig) {
      if (idx !== -1) lista.splice(idx, 1);
      const estadoOrigen = await guardarLista(env, config.kvKey, recurso, lista);

      const { lista: listaDestino } = await cargarLista(env, siguienteConfig.kvKey, siguienteRecurso);
      const idxDestino = listaDestino.findIndex((p) => p.nombre.toLowerCase() === personaActualizada.nombre.toLowerCase());
      const registroDestino = {
        nombre: personaActualizada.nombre,
        resultado: personaActualizada.resultado,
        fecha: personaActualizada.fecha,
        evaluador: personaActualizada.evaluador,
        observaciones: personaActualizada.observaciones,
        historial: personaActualizada.historial,
      };
      if (idxDestino !== -1) listaDestino[idxDestino] = registroDestino; else listaDestino.push(registroDestino);
      await guardarLista(env, siguienteConfig.kvKey, siguienteRecurso, listaDestino);

      return json({ [recurso]: estadoOrigen[recurso], ultimaActualizacion: estadoOrigen.ultimaActualizacion });
    }

    // No hay escalón siguiente todavía (tope actual): se queda acá.
    if (idx === -1) lista.push(personaActualizada); else lista[idx] = personaActualizada;
    const estado = await guardarLista(env, config.kvKey, recurso, lista);
    return json({ [recurso]: estado[recurso], ultimaActualizacion: estado.ultimaActualizacion });
  }

  // ---- arreglar errores: corrige datos a mano (solo admin, del lado
  // cliente). NO agrega intento al historial. ----
  if (payload.arreglarErrores && payload.arreglarErrores.nombre) {
    const nombreLimpio = String(payload.arreglarErrores.nombre).trim();
    const nombreNuevo = payload.arreglarErrores.nombreNuevo
      ? String(payload.arreglarErrores.nombreNuevo).trim()
      : nombreLimpio;

    const persona = lista.find((p) => p.nombre.toLowerCase() === nombreLimpio.toLowerCase());
    if (!persona) return json({ error: "No se encontró a esa persona en esta lista." }, 404);

    persona.nombre = nombreNuevo || persona.nombre;
    if (payload.arreglarErrores.resultado !== undefined) {
      persona.resultado = payload.arreglarErrores.resultado === "reprobado"
        ? "reprobado"
        : (payload.arreglarErrores.resultado ? "aprobado" : null);
    }
    if (payload.arreglarErrores.fecha !== undefined) persona.fecha = payload.arreglarErrores.fecha;
    if (payload.arreglarErrores.evaluador !== undefined) persona.evaluador = payload.arreglarErrores.evaluador;
    if (payload.arreglarErrores.observaciones !== undefined) persona.observaciones = payload.arreglarErrores.observaciones;

    const estado = await guardarLista(env, config.kvKey, recurso, lista);
    return json({ [recurso]: estado[recurso], ultimaActualizacion: estado.ultimaActualizacion });
  }

  // ---- eliminar: borra el registro completo (solo admin, del lado cliente) ----
  if (payload.eliminar && payload.eliminar.nombre) {
    const nombreLimpio = String(payload.eliminar.nombre).trim().toLowerCase();
    const idx = lista.findIndex((p) => p.nombre.toLowerCase() === nombreLimpio);
    if (idx !== -1) {
      lista.splice(idx, 1);
      const estado = await guardarLista(env, config.kvKey, recurso, lista);
      return json({ [recurso]: estado[recurso], ultimaActualizacion: estado.ultimaActualizacion });
    }
    const actual = await cargarLista(env, config.kvKey, recurso);
    return json({ [recurso]: actual.lista, ultimaActualizacion: actual.ultimaActualizacion });
  }

  return json({ error: "Acción de escalafón no reconocida" }, 400);
}

// ==================== asistencias (comportamiento original) ====================
async function manejarAsistencias(request, env, payload) {
  if (request.method === "GET") {
    const { lista, ultimaActualizacion } = await cargarLista(env, KV_KEY_ASISTENCIAS, "asistencias");
    return json({ asistencias: lista, ultimaActualizacion });
  }

  const { lista: asistencias } = await cargarLista(env, KV_KEY_ASISTENCIAS, "asistencias");

  // ---- editar: reemplaza la lista completa de clases de una persona,
  // permite renombrarla vía nombreNuevo ----
  if (payload.edit && payload.edit.nombre) {
    const nombreLimpio = String(payload.edit.nombre).trim();
    const nombreNuevo = payload.edit.nombreNuevo
      ? String(payload.edit.nombreNuevo).trim()
      : nombreLimpio;
    const registrador = payload.edit.registrador || "Desconocido";

    let persona = asistencias.find(
      (p) => p.nombre.toLowerCase() === nombreLimpio.toLowerCase()
    );
    if (!persona) {
      persona = { nombre: nombreNuevo || nombreLimpio, registros: [] };
      asistencias.push(persona);
    }

    const registrosNuevos = Array.isArray(payload.edit.registros)
      ? payload.edit.registros.map((r) => {
          const limpio = limpiarRegistro(r);
          if (!(r && r.registrador)) {
            limpio.registrador = `Editado por ${registrador}`;
          }
          return limpio;
        })
      : persona.registros;

    persona.nombre = nombreNuevo || persona.nombre;
    persona.registros = registrosNuevos;

    const estado = await guardarLista(env, KV_KEY_ASISTENCIAS, "asistencias", asistencias);
    return json({ asistencias: estado.asistencias, ultimaActualizacion: estado.ultimaActualizacion });
  }

  // ---- eliminar: borra por completo el historial de una persona ----
  if (payload.delete && payload.delete.nombre) {
    const nombreLimpio = String(payload.delete.nombre).trim().toLowerCase();
    const idx = asistencias.findIndex((p) => p.nombre.toLowerCase() === nombreLimpio);
    if (idx !== -1) {
      asistencias.splice(idx, 1);
      const estado = await guardarLista(env, KV_KEY_ASISTENCIAS, "asistencias", asistencias);
      return json({ asistencias: estado.asistencias, ultimaActualizacion: estado.ultimaActualizacion });
    }
    const actual = await cargarLista(env, KV_KEY_ASISTENCIAS, "asistencias");
    return json({ asistencias: actual.lista, ultimaActualizacion: actual.ultimaActualizacion });
  }

  // ---- agregar entradas (registrar asistencia) ----
  const entries = Array.isArray(payload.entries) ? payload.entries : [];

  for (const entry of entries) {
    if (!entry || !entry.nombre || !entry.tipo) continue;
    const nombreLimpio = String(entry.nombre).trim();
    if (!nombreLimpio) continue;

    let persona = asistencias.find(
      (p) => p.nombre.toLowerCase() === nombreLimpio.toLowerCase()
    );
    if (!persona) {
      persona = { nombre: nombreLimpio, registros: [] };
      asistencias.push(persona);
    }
    persona.registros.push(limpiarRegistro(entry));
  }

  const estado = await guardarLista(env, KV_KEY_ASISTENCIAS, "asistencias", asistencias);
  return json({ asistencias: estado.asistencias, ultimaActualizacion: estado.ultimaActualizacion });
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }

      if (!env.ASISTENCIAS_KV) {
        return json(
          { error: "Falta el binding ASISTENCIAS_KV en este Worker (Settings → Bindings → KV namespace)." },
          500
        );
      }

      const url = new URL(request.url);

      if (request.method === "GET") {
        const recurso = url.searchParams.get("recurso");
        if (recurso === "evaluaciones") {
          return await manejarEvaluaciones(request, env, {});
        }
        if (recurso && ESCALAFON_CONFIG[recurso]) {
          return await manejarEscalafon(request, env, {}, recurso);
        }
        return await manejarAsistencias(request, env, {});
      }

      if (request.method === "POST") {
        let payload;
        try {
          payload = await request.json();
        } catch (e) {
          return json({ error: "JSON inválido" }, 400);
        }

        if (payload.recurso === "evaluaciones") {
          return await manejarEvaluaciones(request, env, payload);
        }
        if (payload.recurso && ESCALAFON_CONFIG[payload.recurso]) {
          return await manejarEscalafon(request, env, payload, payload.recurso);
        }
        return await manejarAsistencias(request, env, payload);
      }

      return json({ error: "Método no soportado" }, 405);
    } catch (err) {
      // Cualquier error inesperado también sale con headers CORS y con el
      // mensaje real, en vez de un 500 pelado que el navegador reporta como
      // bloqueo de CORS.
      return json({ error: "Error interno del Worker: " + (err && err.message ? err.message : String(err)) }, 500);
    }
  },
};
