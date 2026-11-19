// api/boxhero-webhook.js
//
// Recibe los webhooks de BoxHero (Crear / Editar / Eliminar transacción) y
// actualiza el stock en Supabase. Siempre toma el stock que BoxHero reporta
// como "nivel nuevo" después del movimiento (nunca suma ni resta por su
// cuenta), para que BoxHero sea siempre la fuente de verdad y la web solo
// refleje.
//
// No usa ninguna librería externa (fetch ya viene incluido en el runtime de
// Vercel), así que no hace falta instalar nada.
//
// Variables de entorno necesarias (se configuran en Vercel, nunca acá):
//   SUPABASE_SERVICE_ROLE_KEY  -> clave de servicio de Supabase (Project Settings > API)
//   SUPABASE_URL               -> opcional, ya tiene un valor por defecto correcto
//   BOXHERO_TEAM_ID             -> opcional, filtro de seguridad extra (324897)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://koevucbehoqfktkjjwme.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPECTED_TEAM_ID = process.env.BOXHERO_TEAM_ID || null;

async function supabaseFetch(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!SERVICE_KEY) {
    console.error('Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY');
    res.status(500).json({ error: 'Server misconfigured: falta SUPABASE_SERVICE_ROLE_KEY' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }

  if (!body) {
    res.status(200).json({ ok: true, skipped: 'body vacio o invalido' });
    return;
  }

  if (EXPECTED_TEAM_ID && String(body.team_id) !== String(EXPECTED_TEAM_ID)) {
    res.status(403).json({ error: 'team_id no coincide' });
    return;
  }

  const items = body.payload && Array.isArray(body.payload.items) ? body.payload.items : [];
  if (items.length === 0) {
    res.status(200).json({ ok: true, skipped: 'sin items en el payload' });
    return;
  }

  // nombre del cliente ("partner") asociado a esta orden/transacción en
  // BoxHero, si la trae. Se prueban varios nombres de campo posibles porque
  // la forma exacta del objeto "partner" no está 100% documentada.
  const partner = body.payload && body.payload.partner;
  const cliente = partner
    ? (partner.name || partner.company_name || partner.companyName || partner.title || null)
    : null;
  const tipo = (body.payload && body.payload.type) || null; // "out" | "in" | etc.

  const resultados = [];

  for (const item of items) {
    const boxheroId = item.id;
    const nuevoStock = typeof item.new_stock_level === 'number'
      ? item.new_stock_level
      : (typeof item.to_location_new_stock_level === 'number' ? item.to_location_new_stock_level : null);

    if (boxheroId === undefined || nuevoStock === null) {
      resultados.push({ boxheroId, ok: false, motivo: 'payload sin id o sin new_stock_level' });
      continue;
    }

    // busca el/los productos cuyo array "talles" (jsonb) contiene un elemento con este boxhero_id
    const filtro = encodeURIComponent(JSON.stringify([{ boxhero_id: boxheroId }]));
    const busq = await supabaseFetch(`productos?select=id,marca,nombre,talles&talles=cs.${filtro}`);
    if (!busq.ok) {
      resultados.push({ boxheroId, ok: false, motivo: 'error buscando producto: ' + (await busq.text()) });
      continue;
    }
    const candidatos = await busq.json();

    if (!candidatos || candidatos.length === 0) {
      resultados.push({ boxheroId, ok: false, motivo: 'ningun producto de la web tiene este articulo vinculado todavia' });
      continue;
    }

    for (const producto of candidatos) {
      const talleAfectado = (producto.talles || []).find(t => t.boxhero_id === boxheroId);
      const stockAnterior = talleAfectado ? (talleAfectado.stock || 0) : null;
      const stockNuevo = Math.max(nuevoStock, 0);

      const talles = (producto.talles || []).map(t =>
        t.boxhero_id === boxheroId ? { ...t, stock: stockNuevo } : t
      );
      const upd = await supabaseFetch(`productos?id=eq.${producto.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ talles }),
      });
      if (!upd.ok) {
        resultados.push({ boxheroId, productoId: producto.id, ok: false, motivo: await upd.text() });
        continue;
      }

      resultados.push({ boxheroId, productoId: producto.id, ok: true, nuevoStock: stockNuevo });

      // deja registrado el movimiento para el historial del panel admin.
      // si esto falla no es grave (el stock ya se actualizó bien), así que
      // no se cuenta como error del webhook.
      await supabaseFetch('movimientos_boxhero', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          producto_id: producto.id,
          marca: producto.marca || '',
          nombre: producto.nombre || '',
          talle: talleAfectado ? talleAfectado.talle : null,
          boxhero_id: boxheroId,
          stock_anterior: stockAnterior,
          stock_nuevo: stockNuevo,
          delta: stockAnterior === null ? null : stockNuevo - stockAnterior,
          cliente,
          tipo,
        }),
      }).catch(() => {});
    }
  }

  // limpieza: borra movimientos de más de 30 días para que la tabla no
  // crezca sin límite. No es crítico, así que no bloquea la respuesta
  // del webhook si falla.
  const limite = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  supabaseFetch(`movimientos_boxhero?created_at=lt.${encodeURIComponent(limite)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  }).catch(() => {});

  res.status(200).json({ ok: true, resultados });
};
