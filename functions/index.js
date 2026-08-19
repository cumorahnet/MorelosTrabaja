const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldPath, Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { createHash } = require('crypto');
const functions = require('firebase-functions/v1');

initializeApp();

const SUPERUSER_EMAIL = 'cumorahnet@gmail.com';
const adminFunctions = functions.runWith({ timeoutSeconds: 540, memory: '512MB' });
const CONTACT_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const AD_LIFETIME_MS = 8 * 24 * 60 * 60 * 1000;
const ARCHIVE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function requireRegisteredUser(context) {
  if (!context.auth || context.auth.token.firebase?.sign_in_provider === 'anonymous') {
    throw new functions.https.HttpsError('unauthenticated', 'Inicia sesión con una cuenta para continuar.');
  }
  return context.auth.uid;
}

function validateDocumentId(value, label) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 1500 || id.includes('/')) {
    throw new functions.https.HttpsError('invalid-argument', `${label} no es válido.`);
  }
  return id;
}

function timestampFromMillis(milliseconds) {
  return Timestamp.fromMillis(milliseconds);
}

function adExpirationMillis(ad) {
  if (ad.expiresAt?.toMillis) return ad.expiresAt.toMillis();
  if (ad.fecha?.toMillis) return ad.fecha.toMillis() + AD_LIFETIME_MS;
  return 0;
}

function isAdActive(ad, now = Date.now()) {
  return (!ad.estado || ad.estado === 'activo') && adExpirationMillis(ad) > now;
}

function maskEmail(email) {
  const normalized = String(email || 'usuario').toLowerCase();
  const [name, domain] = normalized.split('@');
  if (!domain) return 'Usuario de Morelos Trabaja';
  return `${name.slice(0, 1) || '*'}***@${domain}`;
}

async function getUserLabels(uids) {
  const labels = {};
  const uniqueUids = [...new Set(uids.filter(Boolean))];
  for (let index = 0; index < uniqueUids.length; index += 100) {
    const chunk = uniqueUids.slice(index, index + 100);
    const profileSnapshots = await getFirestore().getAll(...chunk.map(uid => getFirestore().collection('usuarios').doc(uid)));
    const missingUids = [];
    profileSnapshots.forEach((snapshot, profileIndex) => {
      const uid = chunk[profileIndex];
      const name = String(snapshot.get('nombreCompleto') || '').trim();
      if (name) labels[uid] = name;
      else missingUids.push(uid);
    });
    if (missingUids.length) {
      const result = await getAuth().getUsers(missingUids.map(uid => ({ uid })));
      result.users.forEach(user => { labels[user.uid] = user.displayName || maskEmail(user.email); });
      result.notFound.forEach(identifier => { labels[identifier.uid] = 'Usuario de Morelos Trabaja'; });
    }
  }
  return labels;
}

function requireSuperUser(context) {
  const email = String(context.auth?.token?.email || '').toLowerCase();
  if (!context.auth || email !== SUPERUSER_EMAIL || context.auth.token.email_verified !== true) {
    throw new functions.https.HttpsError('permission-denied', 'Acceso exclusivo del superusuario.');
  }
}

async function finalizeContact(contactRef) {
  const db = getFirestore();
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(contactRef);
    if (!snapshot.exists) return false;
    const contact = snapshot.data();
    if (contact.finalized === true) return false;

    const bothRated = Number.isInteger(contact.contactorRating) && Number.isInteger(contact.advertiserRating);
    const deadlinePassed = contact.ratingDeadline?.toMillis?.() <= Date.now();
    if (!bothRated && !deadlinePassed) return false;

    const now = Timestamp.now();
    if (Number.isInteger(contact.contactorRating)) {
      const ratingRef = db.collection('calificaciones').doc(`${snapshot.id}_to_${contact.advertiserUid}`);
      transaction.set(ratingRef, {
        contactId: snapshot.id,
        adId: contact.adId,
        authorUid: contact.advertiserUid,
        raterUid: contact.contactorUid,
        rating: contact.contactorRating,
        createdAt: contact.contactorRatedAt || now
      });
    }
    if (Number.isInteger(contact.advertiserRating)) {
      const ratingRef = db.collection('calificaciones').doc(`${snapshot.id}_to_${contact.contactorUid}`);
      transaction.set(ratingRef, {
        contactId: snapshot.id,
        adId: contact.adId,
        authorUid: contact.contactorUid,
        raterUid: contact.advertiserUid,
        rating: contact.advertiserRating,
        createdAt: contact.advertiserRatedAt || now
      });
    }

    transaction.update(contactRef, {
      finalized: true,
      needsFinalization: false,
      status: bothRated ? 'evaluado' : 'vencido',
      finalizedAt: now
    });
    return true;
  });
}

exports.registerContact = adminFunctions.https.onCall(async (data, context) => {
  const contactorUid = requireRegisteredUser(context);
  const adId = validateDocumentId(data?.adId, 'El identificador del anuncio');
  const db = getFirestore();
  const adRef = db.collection('anuncios').doc(adId);
  const contactRef = db.collection('contactos').doc(`${adId}_${contactorUid}`);

  const result = await db.runTransaction(async transaction => {
    const [adSnapshot, contactSnapshot] = await Promise.all([
      transaction.get(adRef),
      transaction.get(contactRef)
    ]);
    if (!adSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', 'El anuncio ya no está disponible.');
    }
    const ad = adSnapshot.data();
    if (!isAdActive(ad)) {
      throw new functions.https.HttpsError('failed-precondition', 'El anuncio ya no está activo.');
    }
    if (ad.authorUid === contactorUid) {
      throw new functions.https.HttpsError('failed-precondition', 'No puedes registrar contacto con tu propio anuncio.');
    }
    if (contactSnapshot.exists) {
      const existing = contactSnapshot.data();
      return { contactId: contactSnapshot.id, ratingDeadline: existing.ratingDeadline.toDate().toISOString(), created: false };
    }

    const now = Timestamp.now();
    const ratingDeadline = timestampFromMillis(now.toMillis() + CONTACT_WINDOW_MS);
    transaction.create(contactRef, {
      adId,
      adTitle: String(ad.titulo || 'Anuncio'),
      category: String(ad.categoria || ''),
      advertiserUid: ad.authorUid,
      contactorUid,
      createdAt: now,
      ratingDeadline,
      contactorRating: null,
      advertiserRating: null,
      finalized: false,
      needsFinalization: true,
      status: 'pendiente'
    });
    return { contactId: contactRef.id, ratingDeadline: ratingDeadline.toDate().toISOString(), created: true };
  });

  return result;
});

exports.recordAdView = adminFunctions.https.onCall(async (data, context) => {
  const viewerUid = requireRegisteredUser(context);
  const adId = validateDocumentId(data?.adId, 'El identificador del anuncio');
  const db = getFirestore();
  const adRef = db.collection('anuncios').doc(adId);
  const viewId = createHash('sha256').update(`${adId}:${viewerUid}`).digest('hex');
  const viewRef = db.collection('vistasAnuncios').doc(viewId);

  return db.runTransaction(async transaction => {
    const [adSnapshot, viewSnapshot] = await Promise.all([
      transaction.get(adRef),
      transaction.get(viewRef)
    ]);
    if (!adSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', 'El anuncio ya no está disponible.');
    }
    const ad = adSnapshot.data();
    const currentCount = Math.max(0, Number(ad.viewCount || 0));
    if (ad.authorUid === viewerUid) return { counted: false, viewCount: currentCount };
    if (!isAdActive(ad)) return { counted: false, viewCount: currentCount };
    if (viewSnapshot.exists) return { counted: false, viewCount: currentCount };

    const nextCount = currentCount + 1;
    transaction.create(viewRef, {
      adId,
      viewerUid,
      createdAt: Timestamp.now(),
      purgeAt: timestampFromMillis((adExpirationMillis(ad) || Date.now()) + ARCHIVE_RETENTION_MS)
    });
    transaction.update(adRef, { viewCount: nextCount });
    return { counted: true, viewCount: nextCount };
  });
});

exports.listMyContacts = adminFunctions.https.onCall(async (_data, context) => {
  const uid = requireRegisteredUser(context);
  const db = getFirestore();
  const [asContactor, asAdvertiser] = await Promise.all([
    db.collection('contactos').where('contactorUid', '==', uid).limit(100).get(),
    db.collection('contactos').where('advertiserUid', '==', uid).limit(100).get()
  ]);
  const documents = [...asContactor.docs, ...asAdvertiser.docs];

  await Promise.all(documents.map(document => {
    const contact = document.data();
    const bothRated = Number.isInteger(contact.contactorRating) && Number.isInteger(contact.advertiserRating);
    const expired = contact.ratingDeadline?.toMillis?.() <= Date.now();
    return !contact.finalized && (bothRated || expired) ? finalizeContact(document.ref) : null;
  }));

  const counterpartUids = documents.map(document => {
    const contact = document.data();
    return contact.contactorUid === uid ? contact.advertiserUid : contact.contactorUid;
  });
  const labels = await getUserLabels(counterpartUids);
  const now = Date.now();
  const contacts = documents.map(document => {
    const contact = document.data();
    const isContactor = contact.contactorUid === uid;
    const ownRating = isContactor ? contact.contactorRating : contact.advertiserRating;
    const counterpartRating = isContactor ? contact.advertiserRating : contact.contactorRating;
    const revealRatings = (Number.isInteger(contact.contactorRating) && Number.isInteger(contact.advertiserRating))
      || contact.ratingDeadline?.toMillis?.() <= now;
    const counterpartUid = isContactor ? contact.advertiserUid : contact.contactorUid;
    return {
      id: document.id,
      adId: contact.adId,
      adTitle: contact.adTitle,
      category: contact.category,
      role: isContactor ? 'contactor' : 'advertiser',
      counterpart: labels[counterpartUid] || 'Usuario de Morelos Trabaja',
      createdAt: contact.createdAt?.toDate?.().toISOString() || null,
      ratingDeadline: contact.ratingDeadline?.toDate?.().toISOString() || null,
      ownRating: Number.isInteger(ownRating) ? ownRating : null,
      counterpartRated: Number.isInteger(counterpartRating),
      counterpartRating: revealRatings && Number.isInteger(counterpartRating) ? counterpartRating : null,
      canRate: !Number.isInteger(ownRating) && contact.ratingDeadline?.toMillis?.() > now,
      status: contact.finalized ? contact.status : 'pendiente'
    };
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return { contacts };
});

exports.submitContactRating = adminFunctions.https.onCall(async (data, context) => {
  const uid = requireRegisteredUser(context);
  const contactId = validateDocumentId(data?.contactId, 'El contacto');
  const rating = Number(data?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new functions.https.HttpsError('invalid-argument', 'La calificación debe estar entre 1 y 5.');
  }

  const db = getFirestore();
  const contactRef = db.collection('contactos').doc(contactId);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(contactRef);
    if (!snapshot.exists) throw new functions.https.HttpsError('not-found', 'El contacto no existe.');
    const contact = snapshot.data();
    const isContactor = contact.contactorUid === uid;
    const isAdvertiser = contact.advertiserUid === uid;
    if (!isContactor && !isAdvertiser) {
      throw new functions.https.HttpsError('permission-denied', 'No perteneces a este contacto.');
    }
    if (contact.ratingDeadline?.toMillis?.() <= Date.now()) {
      throw new functions.https.HttpsError('deadline-exceeded', 'El plazo de 5 días para evaluar terminó.');
    }
    const ratingField = isContactor ? 'contactorRating' : 'advertiserRating';
    if (Number.isInteger(contact[ratingField])) {
      throw new functions.https.HttpsError('already-exists', 'Ya evaluaste este contacto.');
    }
    transaction.update(contactRef, {
      [ratingField]: rating,
      [`${ratingField === 'contactorRating' ? 'contactor' : 'advertiser'}RatedAt`]: Timestamp.now()
    });
  });

  await finalizeContact(contactRef);
  return { saved: true };
});

exports.closeAd = adminFunctions.https.onCall(async (data, context) => {
  const uid = requireRegisteredUser(context);
  const adId = validateDocumentId(data?.adId, 'El identificador del anuncio');
  const reason = String(data?.reason || 'retirado');
  if (!['cubierto', 'vendido', 'retirado'].includes(reason)) {
    throw new functions.https.HttpsError('invalid-argument', 'El motivo de cierre no es válido.');
  }

  const db = getFirestore();
  const adRef = db.collection('anuncios').doc(adId);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(adRef);
    if (!snapshot.exists) throw new functions.https.HttpsError('not-found', 'El anuncio no existe.');
    const ad = snapshot.data();
    const email = String(context.auth.token.email || '').toLowerCase();
    const canClose = ad.authorUid === uid || (email === SUPERUSER_EMAIL && context.auth.token.email_verified === true);
    if (!canClose) throw new functions.https.HttpsError('permission-denied', 'Sólo el propietario puede retirar el anuncio.');
    const now = Timestamp.now();
    transaction.update(adRef, {
      estado: reason,
      closedReason: reason,
      closedAt: now,
      purgeAt: timestampFromMillis(now.toMillis() + ARCHIVE_RETENTION_MS)
    });
  });
  return { closed: true, adId, reason };
});

exports.adminListUsers = adminFunctions.https.onCall(async (_data, context) => {
  requireSuperUser(context);
  const users = [];
  let pageToken;
  do {
    const page = await getAuth().listUsers(1000, pageToken);
    users.push(...page.users.map(user => ({
      uid: user.uid,
      email: user.email || '',
      disabled: user.disabled,
      createdAt: user.metadata.creationTime || '',
      lastLoginAt: user.metadata.lastSignInTime || ''
    })));
    pageToken = page.pageToken;
  } while (pageToken);
  users.sort((a, b) => a.email.localeCompare(b.email));
  return { users };
});

async function deleteQueryInBatches(query) {
  while (true) {
    const snapshot = await query.limit(400).get();
    if (snapshot.empty) return;
    const batch = getFirestore().batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }
}

async function deleteAdPhotos(authorUid, adId) {
  if (!authorUid || !adId) return;
  await getStorage().bucket().deleteFiles({
    prefix: `anuncios/${authorUid}/${adId}/`,
    force: true
  });
}

async function deleteUserData(db, uid) {
  const authoredAds = await db.collection('anuncios').where('authorUid', '==', uid).get();
  await deleteQueryInBatches(db.collection('anuncios').where('authorUid', '==', uid));
  for (const adDocument of authoredAds.docs) {
    await deleteAdPhotos(uid, adDocument.id);
    await deleteQueryInBatches(db.collection('vistasAnuncios').where('adId', '==', adDocument.id));
  }
  await deleteQueryInBatches(db.collection('contactos').where('advertiserUid', '==', uid));
  await deleteQueryInBatches(db.collection('contactos').where('contactorUid', '==', uid));
  await deleteQueryInBatches(db.collection('calificaciones').where('authorUid', '==', uid));
  await deleteQueryInBatches(db.collection('calificaciones').where('raterUid', '==', uid));
  await deleteQueryInBatches(db.collection('vistasAnuncios').where('viewerUid', '==', uid));
  await db.collection('usuarios').doc(uid).delete();
}

exports.adminDeleteAd = adminFunctions.https.onCall(async (data, context) => {
  requireSuperUser(context);
  const adId = typeof data?.adId === 'string' ? data.adId.trim() : '';
  if (!adId || adId.length > 1500 || adId.includes('/')) {
    throw new functions.https.HttpsError('invalid-argument', 'El identificador del anuncio no es válido.');
  }

  const adRef = getFirestore().collection('anuncios').doc(adId);
  const snapshot = await adRef.get();
  if (!snapshot.exists) return { deleted: false, notFound: true, adId };

  await adRef.delete();
  await deleteAdPhotos(snapshot.get('authorUid'), adId);
  await deleteQueryInBatches(getFirestore().collection('vistasAnuncios').where('adId', '==', adId));
  functions.logger.info('Anuncio eliminado por el superusuario', {
    adId,
    adminUid: context.auth.uid,
    authorUid: snapshot.get('authorUid') || null
  });
  return { deleted: true, notFound: false, adId };
});

exports.adminDeleteUsers = adminFunctions.https.onCall(async (data, context) => {
  requireSuperUser(context);
  const requested = Array.isArray(data?.uids) ? data.uids : [];
  const uids = [...new Set(requested.filter(uid => typeof uid === 'string' && uid.length <= 128))].slice(0, 100);
  if (!uids.length) throw new functions.https.HttpsError('invalid-argument', 'Selecciona al menos un usuario.');

  if (uids.includes(context.auth.uid)) {
    throw new functions.https.HttpsError('failed-precondition', 'La cuenta del superusuario no se puede eliminar.');
  }

  const db = getFirestore();
  const results = [];
  for (const uid of uids) {
    try {
      await deleteUserData(db, uid);
      try {
        await getAuth().deleteUser(uid);
      } catch (error) {
        if (error.code !== 'auth/user-not-found') throw error;
      }
      results.push({ uid, deleted: true });
      functions.logger.info('Usuario y datos asociados eliminados por el superusuario', {
        uid,
        adminUid: context.auth.uid
      });
    } catch (error) {
      functions.logger.error('No fue posible eliminar completamente al usuario', {
        uid,
        adminUid: context.auth.uid,
        code: error.code || 'unknown',
        message: error.message || String(error)
      });
      results.push({ uid, deleted: false, error: String(error.code || 'internal') });
    }
  }

  const deleted = results.filter(result => result.deleted).length;
  return { deleted, failed: results.length - deleted, results };
});

async function backfillAdExpirations() {
  const db = getFirestore();
  const markerRef = db.collection('_sistema').doc('adExpirationV1');
  if ((await markerRef.get()).exists) return;

  let lastDocument = null;
  let processed = 0;
  while (true) {
    let query = db.collection('anuncios').orderBy(FieldPath.documentId()).limit(400);
    if (lastDocument) query = query.startAfter(lastDocument);
    const snapshot = await query.get();
    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach(document => {
      const ad = document.data();
      const createdMillis = ad.fecha?.toMillis?.() || Date.now();
      const expiresMillis = ad.expiresAt?.toMillis?.() || createdMillis + AD_LIFETIME_MS;
      const updates = {};
      if (!ad.expiresAt) updates.expiresAt = timestampFromMillis(expiresMillis);
      if (!ad.estado) updates.estado = expiresMillis <= Date.now() ? 'vencido' : 'activo';
      if (expiresMillis <= Date.now() && (!ad.estado || ad.estado === 'activo')) {
        updates.estado = 'vencido';
        updates.closedReason = 'vencido';
        updates.closedAt = timestampFromMillis(expiresMillis);
        updates.purgeAt = timestampFromMillis(expiresMillis + ARCHIVE_RETENTION_MS);
      }
      if (Object.keys(updates).length) batch.update(document.ref, updates);
    });
    await batch.commit();
    processed += snapshot.size;
    lastDocument = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < 400) break;
  }

  await markerRef.set({ completedAt: Timestamp.now(), processed });
  functions.logger.info('Migración de vencimientos completada', { processed });
}

exports.expireAds = adminFunctions.pubsub
  .schedule('every 60 minutes')
  .timeZone('America/Mexico_City')
  .onRun(async () => {
    await backfillAdExpirations();
    const db = getFirestore();
    let expired = 0;
    while (true) {
      const snapshot = await db.collection('anuncios')
        .where('estado', '==', 'activo')
        .where('expiresAt', '<=', Timestamp.now())
        .limit(400)
        .get();
      if (snapshot.empty) break;
      const now = Timestamp.now();
      const purgeAt = timestampFromMillis(now.toMillis() + ARCHIVE_RETENTION_MS);
      const batch = db.batch();
      snapshot.docs.forEach(document => batch.update(document.ref, {
        estado: 'vencido',
        closedReason: 'vencido',
        closedAt: now,
        purgeAt
      }));
      await batch.commit();
      expired += snapshot.size;
    }
    functions.logger.info('Anuncios vencidos archivados', { expired });
    return null;
  });

exports.finalizeExpiredContacts = adminFunctions.pubsub
  .schedule('every 60 minutes')
  .timeZone('America/Mexico_City')
  .onRun(async () => {
    const db = getFirestore();
    let finalized = 0;
    while (true) {
      const snapshot = await db.collection('contactos')
        .where('needsFinalization', '==', true)
        .where('ratingDeadline', '<=', Timestamp.now())
        .limit(400)
        .get();
      if (snapshot.empty) break;
      const results = await Promise.all(snapshot.docs.map(document => finalizeContact(document.ref)));
      finalized += results.filter(Boolean).length;
    }
    functions.logger.info('Contactos vencidos finalizados', { finalized });
    return null;
  });

exports.purgeArchivedAds = adminFunctions.pubsub
  .schedule('every day 03:00')
  .timeZone('America/Mexico_City')
  .onRun(async () => {
    const db = getFirestore();
    let deleted = 0;
    while (true) {
      const snapshot = await db.collection('anuncios')
        .where('purgeAt', '<=', Timestamp.now())
        .limit(400)
        .get();
      if (snapshot.empty) break;
      const batch = db.batch();
      snapshot.docs.forEach(document => batch.delete(document.ref));
      await batch.commit();
      for (const document of snapshot.docs) {
        await deleteAdPhotos(document.get('authorUid'), document.id);
      }
      deleted += snapshot.size;
    }
    let deletedViews = 0;
    while (true) {
      const viewSnapshot = await db.collection('vistasAnuncios')
        .where('purgeAt', '<=', Timestamp.now())
        .limit(400)
        .get();
      if (viewSnapshot.empty) break;
      const batch = db.batch();
      viewSnapshot.docs.forEach(document => batch.delete(document.ref));
      await batch.commit();
      deletedViews += viewSnapshot.size;
    }
    functions.logger.info('Anuncios y vistas archivados eliminados definitivamente', { deleted, deletedViews });
    return null;
  });
