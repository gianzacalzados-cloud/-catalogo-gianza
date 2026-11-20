// api/boxhero-webhook.js
//
// Recibe los webhooks de BoxHero (Crear / Editar / Eliminar transacción,
// Editar artículo, y Crear artículo) y actualiza Supabase. Para el stock,
// siempre toma el nivel que BoxHero reporta como "nivel nuevo" después del
// movimiento (nunca suma ni resta por su cuenta), para que BoxHero sea
// siempre la fuente de verdad y la web solo refleje. Para el precio, toma
// el precio nuevo del evento "item/edit" (edición manual de un artículo en
// BoxHero, no carga masiva ni Excel) y lo aplica a todo el producto en la
// web. Para artículos nuevos ("item/new"), crea o completa el producto en
// la web automáticamente -- si es un modelo nuevo entero, lo crea OCULTO
// (visible:false) hasta que alguien le ponga categoría y lo publique a
// mano desde el panel.
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

  // "item/delete": BoxHero borró un artículo (en la práctica, un talle
  // puntual, ya que cada talle es su propia "variante de artículo" en
  // BoxHero). La web tiene que reflejarlo: se saca ese talle del producto,
  // y si era el último talle que le quedaba, se borra el producto entero.
  if (body.topic === 'item/delete') {
    const boxheroId = body.payload && body.payload.id;
    if (boxheroId === undefined) {
      res.status(200).json({ ok: true, skipped: 'evento de borrado sin id' });
      return;
    }

    const filtro = encodeURIComponent(JSON.stringify([{ boxhero_id: boxheroId }]));
    const busq = await supabaseFetch(`productos?select=id,marca,nombre,talles,foto&talles=cs.${filtro}`);
    if (!busq.ok) {
      res.status(200).json({ ok: false, motivo: 'error buscando producto: ' + (await busq.text()) });
      return;
    }
    const candidatos = await busq.json();
    const resultados = [];

    for (const producto of candidatos) {
      const talleBorrado = (producto.talles || []).find(t => t.boxhero_id === boxheroId);
      const tallesRestantes = (producto.talles || []).filter(t => t.boxhero_id !== boxheroId);

      // deja registrado el movimiento ANTES de borrar/actualizar el producto,
      // mientras todavía existe (si el producto se termina borrando, esta fila
      // igual queda guardada: el vínculo a producto_id se pone en null solo).
      await supabaseFetch('movimientos_boxhero', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          producto_id: producto.id,
          marca: producto.marca || '',
          nombre: producto.nombre || '',
          foto: producto.foto || null,
          talle: talleBorrado ? talleBorrado.talle : null,
          boxhero_id: boxheroId,
          stock_anterior: talleBorrado ? (talleBorrado.stock || 0) : null,
          stock_nuevo: 0,
          delta: talleBorrado ? -(talleBorrado.stock || 0) : null,
          cliente: null,
          tipo: 'eliminado',
        }),
      }).catch(() => {});

      if (tallesRestantes.length === 0) {
        // era el único talle que le quedaba a este producto: se borra entero
        const del = await supabaseFetch(`productos?id=eq.${producto.id}`, {
          method: 'DELETE',
          headers: { Prefer: 'return=minimal' },
        });
        resultados.push({ boxheroId, productoId: producto.id, ok: del.ok, accion: 'producto_borrado' });
      } else {
        const upd = await supabaseFetch(`productos?id=eq.${producto.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ talles: tallesRestantes }),
        });
        resultados.push({ boxheroId, productoId: producto.id, ok: upd.ok, accion: 'talle_borrado' });
      }
    }

    res.status(200).json({ ok: true, resultados });
    return;
  }

  // "item/edit": se editó un artículo directamente en BoxHero (no por carga
  // masiva ni importación de Excel, esos no disparan este evento). Si trae
  // un precio nuevo, lo reflejamos en el producto de la web. El precio es
  // por PRODUCTO (todos los talles de un mismo modelo comparten precio), así
  // que alcanza con editar el precio de cualquiera de sus talles/variantes
  // en BoxHero para que se actualice toda la tarjeta en la web.
  if (body.topic === 'item/edit') {
    const boxheroId = body.payload && body.payload.id;
    const precioRaw = body.payload && body.payload.price;

    if (boxheroId === undefined) {
      res.status(200).json({ ok: true, skipped: 'evento de edición sin id' });
      return;
    }
    const precioNuevo = parseFloat(precioRaw);
    if (precioRaw === undefined || precioRaw === null || precioRaw === '' || isNaN(precioNuevo)) {
      res.status(200).json({ ok: true, skipped: 'evento de edición sin precio valido' });
      return;
    }

    // el talle de la variante editada, solo para mostrarlo en el historial
    // (el precio se aplica a TODO el producto, no solo a este talle)
    const attrs = (body.payload && body.payload.attrs) || [];
    const talleAttr = attrs.find(a => (a.name || '').toLowerCase() === 'talle');
    const talleEditado = talleAttr ? talleAttr.value : null;

    const filtro = encodeURIComponent(JSON.stringify([{ boxhero_id: boxheroId }]));
    const busq = await supabaseFetch(`productos?select=id,marca,nombre,precio,foto&talles=cs.${filtro}`);
    if (!busq.ok) {
      res.status(200).json({ ok: false, motivo: 'error buscando producto: ' + (await busq.text()) });
      return;
    }
    const candidatos = await busq.json();

    if (!candidatos || candidatos.length === 0) {
      res.status(200).json({ ok: true, skipped: 'ningun producto de la web tiene este articulo vinculado todavia' });
      return;
    }

    const resultados = [];
    for (const producto of candidatos) {
      const precioAnterior = producto.precio;
      const upd = await supabaseFetch(`productos?id=eq.${producto.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ precio: precioNuevo }),
      });
      resultados.push({
        boxheroId,
        productoId: producto.id,
        ok: upd.ok,
        precioAnterior,
        precioNuevo,
        motivo: upd.ok ? undefined : await upd.text(),
      });

      if (upd.ok && precioAnterior !== precioNuevo) {
        await supabaseFetch('movimientos_boxhero', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            producto_id: producto.id,
            marca: producto.marca || '',
            nombre: producto.nombre || '',
            foto: producto.foto || null,
            talle: talleEditado,
            boxhero_id: boxheroId,
            precio_anterior: precioAnterior,
            precio_nuevo: precioNuevo,
            cliente: null,
            tipo: 'precio_editado',
          }),
        }).catch(() => {});
      }
    }

    res.status(200).json({ ok: true, resultados });
    return;
  }

  // "item/new": se dio de alta un artículo nuevo en BoxHero (puede ser un
  // modelo completamente nuevo, o un talle/variante nueva de un modelo que
  // ya existía en la web). Lo creamos o lo sumamos automáticamente, pero
  // SIEMPRE OCULTO (visible:false) si es un modelo nuevo entero -- así nunca
  // aparece un producto a medio cargar (sin categoría, sin revisar) en el
  // catálogo público. Hay que entrar al panel, ponerle categoría, y
  // mostrarlo a mano cuando esté listo para publicarse.
  if (body.topic === 'item/new') {
    const boxheroId = body.payload && body.payload.id;
    if (boxheroId === undefined) {
      res.status(200).json({ ok: true, skipped: 'evento de alta sin id' });
      return;
    }

    const attrs = (body.payload && body.payload.attrs) || [];
    if (attrs.length === 0) {
      // filas contables (ENVIO, DESCUENTO, SEÑA, etc.): no son productos de catálogo
      res.status(200).json({ ok: true, skipped: 'articulo sin atributos (no es un producto de catalogo)' });
      return;
    }

    const norm = (s) => (s || '')
      .toString()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .trim()
      .replace(/\s+/g, ' ');

    const talleAttr = attrs.find(a => (a.name || '').toLowerCase() === 'talle');
    const marcaAttr = attrs.find(a => (a.name || '').toLowerCase() === 'marca');
    const talle = talleAttr ? String(talleAttr.value) : '';
    const nombreBox = body.payload.name || '';
    const marcaBox = marcaAttr ? String(marcaAttr.value) : '';
    const precioRaw = parseFloat(body.payload.price);
    const foto = body.payload.photo_url || null;
    const stockInicial = typeof body.payload.quantity === 'number' ? body.payload.quantity : 0;

    // si este boxhero_id ya está vinculado a algo (evento repetido o
    // procesado dos veces), no duplicamos nada.
    const filtroYaExiste = encodeURIComponent(JSON.stringify([{ boxhero_id: boxheroId }]));
    const yaVinculado = await supabaseFetch(`productos?select=id&talles=cs.${filtroYaExiste}`);
    if (yaVinculado.ok) {
      const existentes = await yaVinculado.json();
      if (existentes && existentes.length > 0) {
        res.status(200).json({ ok: true, skipped: 'este articulo ya estaba vinculado' });
        return;
      }
    }

    // ¿ya existe el modelo (mismo nombre + marca) en la web, solo que con
    // otros talles? si es así, le sumamos el talle nuevo en vez de crear un
    // producto duplicado.
    const busqTodos = await supabaseFetch(`productos?select=id,marca,nombre,talles`);
    let productoExistente = null;
    if (busqTodos.ok) {
      const todos = await busqTodos.json();
      productoExistente = (todos || []).find(p =>
        norm(p.marca) === norm(marcaBox) && norm(p.nombre) === norm(nombreBox)
      );
    }

    if (productoExistente) {
      const talles = (productoExistente.talles || []).slice();
      const idxMismoTalle = talles.findIndex(t => norm(t.talle) === norm(talle));
      if (idxMismoTalle >= 0) {
        talles[idxMismoTalle] = { ...talles[idxMismoTalle], boxhero_id: boxheroId, stock: stockInicial };
      } else {
        talles.push({ talle, stock: stockInicial, boxhero_id: boxheroId });
      }
      const upd = await supabaseFetch(`productos?id=eq.${productoExistente.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ talles }),
      });
      if (upd.ok) {
        await supabaseFetch('movimientos_boxhero', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            producto_id: productoExistente.id,
            marca: marcaBox,
            nombre: nombreBox,
            foto,
            talle,
            boxhero_id: boxheroId,
            stock_anterior: null,
            stock_nuevo: stockInicial,
            delta: null,
            cliente: null,
            tipo: 'talle_nuevo',
          }),
        }).catch(() => {});
      }
      res.status(200).json({
        ok: upd.ok,
        accion: 'talle_agregado_a_modelo_existente',
        productoId: productoExistente.id,
        motivo: upd.ok ? undefined : await upd.text(),
      });
      return;
    }

    // modelo completamente nuevo: se crea OCULTO, para que alguien le ponga
    // categoría y lo revise antes de publicarlo.
    const nuevoProducto = {
      nombre: nombreBox,
      marca: marcaBox,
      modelo: null,
      categoria: null,
      precio: isNaN(precioRaw) ? null : precioRaw,
      foto: foto || '',
      visible: false,
      talles: [{ talle, stock: stockInicial, boxhero_id: boxheroId }],
    };
    const creado = await supabaseFetch('productos', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(nuevoProducto),
    });
    const filasCreadas = creado.ok ? await creado.json() : null;
    const productoId = filasCreadas && filasCreadas[0] ? filasCreadas[0].id : null;

    if (creado.ok) {
      await supabaseFetch('movimientos_boxhero', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          producto_id: productoId,
          marca: marcaBox,
          nombre: nombreBox,
          foto,
          talle,
          boxhero_id: boxheroId,
          stock_anterior: null,
          stock_nuevo: stockInicial,
          delta: null,
          cliente: null,
          tipo: 'modelo_nuevo',
        }),
      }).catch(() => {});
    }

    res.status(200).json({
      ok: creado.ok,
      accion: 'modelo_nuevo_creado_oculto',
      productoId,
      motivo: creado.ok ? undefined : await creado.text(),
    });
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
    const busq = await supabaseFetch(`productos?select=id,marca,nombre,talles,foto&talles=cs.${filtro}`);
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
          foto: producto.foto || null,
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

  // limpieza: borra movimientos de más de 20 días para que la tabla no
  // crezca sin límite. No es crítico, así que no bloquea la respuesta
  // del webhook si falla.
  const limite = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  supabaseFetch(`movimientos_boxhero?created_at=lt.${encodeURIComponent(limite)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  }).catch(() => {});

  res.status(200).json({ ok: true, resultados });
};
