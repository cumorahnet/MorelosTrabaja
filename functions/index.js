const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const functions = require('firebase-functions/v1');

initializeApp();

const SUPERUSER_EMAIL = 'cumorahnet@gmail.com';

function requireSuperUser(context) {
  const email = String(context.auth?.token?.email || '').toLowerCase();
  if (!context.auth || email !== SUPERUSER_EMAIL || context.auth.token.email_verified !== true) {
    throw new functions.https.HttpsError('permission-denied', 'Acceso exclusivo del superusuario.');
  }
}

exports.adminListUsers = functions.https.onCall(async (_data, context) => {
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

exports.adminDeleteUsers = functions.https.onCall(async (data, context) => {
  requireSuperUser(context);
  const requested = Array.isArray(data?.uids) ? data.uids : [];
  const uids = [...new Set(requested.filter(uid => typeof uid === 'string' && uid.length <= 128))].slice(0, 100);
  if (!uids.length) throw new functions.https.HttpsError('invalid-argument', 'Selecciona al menos un usuario.');

  const superUser = await getAuth().getUserByEmail(SUPERUSER_EMAIL);
  if (uids.includes(superUser.uid)) {
    throw new functions.https.HttpsError('failed-precondition', 'La cuenta del superusuario no se puede eliminar.');
  }

  const db = getFirestore();
  for (const uid of uids) {
    await deleteQueryInBatches(db.collection('anuncios').where('authorUid', '==', uid));
    await deleteQueryInBatches(db.collection('calificaciones').where('authorUid', '==', uid));
    await deleteQueryInBatches(db.collection('calificaciones').where('raterUid', '==', uid));
    await db.collection('usuarios').doc(uid).delete();
  }
  const result = await getAuth().deleteUsers(uids);
  if (result.failureCount) {
    functions.logger.error('Algunas cuentas no pudieron eliminarse', result.errors);
  }
  return { deleted: result.successCount, failed: result.failureCount };
});
