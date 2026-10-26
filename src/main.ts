import './style.css';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { mountPrices } from './prices';
import { escapeHtml } from './format';

const app = document.querySelector<HTMLDivElement>('#app')!;
let currentUserId: string | null | undefined;

// Ne pas appeler Supabase directement dans ce callback (risque de blocage) : on passe par setTimeout.
supabase.auth.onAuthStateChange((_event, session) => {
  const uid = session?.user.id ?? null;
  if (uid === currentUserId) return; // ignore les simples rafraîchissements de jeton
  currentUserId = uid;
  setTimeout(() => void route(session), 0);
});

async function route(session: Session | null) {
  if (!session) return renderLogin();
  const { data, error } = await supabase
    .from('members').select('user_id').eq('user_id', session.user.id).maybeSingle();
  if (error) return renderMessage(`Erreur de connexion à la base : ${error.message}`);
  if (!data) return renderJoin(session);
  renderApp(session);
}

const brand = `<div class="brand"><span class="coin" aria-hidden="true"></span>Comptoir du Kinah</div>`;

function renderLogin() {
  app.innerHTML = `<main class="gate">
    ${brand}
    <p>Les prix de l’hôtel des ventes relevés par le groupe.</p>
    <button class="btn discord" id="login">Se connecter avec Discord</button>
  </main>`;
  app.querySelector('#login')!.addEventListener('click', async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'discord',
      options: { redirectTo: window.location.origin + import.meta.env.BASE_URL },
    });
    if (error) renderMessage(`Connexion Discord impossible : ${error.message}`);
  });
}

function renderJoin(session: Session) {
  const name = session.user.user_metadata?.full_name ?? 'toi';
  app.innerHTML = `<main class="gate">
    ${brand}
    <p>Bienvenue ${escapeHtml(String(name))}. Entre le code d’invitation du groupe pour accéder aux prix.</p>
    <form id="join" class="stack">
      <label>Code d’invitation <input name="code" required autocomplete="off" /></label>
      <p class="error" hidden></p>
      <button class="btn primary" type="submit">Rejoindre le groupe</button>
      <button class="btn ghost" type="button" id="logout">Se déconnecter</button>
    </form>
  </main>`;
  const form = app.querySelector<HTMLFormElement>('#join')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = (new FormData(form).get('code') as string).trim();
    const { data, error } = await supabase.rpc('join_group', { code });
    const err = form.querySelector<HTMLElement>('.error')!;
    if (error || !data) {
      err.hidden = false;
      err.textContent = error ? error.message : 'Code incorrect. Demande-le à l’admin du groupe.';
      return;
    }
    renderApp(session);
  });
  app.querySelector('#logout')!.addEventListener('click', () => void supabase.auth.signOut());
}

function renderApp(session: Session) {
  const name = session.user.user_metadata?.full_name ?? session.user.email ?? '';
  app.innerHTML = `
    <header class="topbar">
      ${brand}
      <div class="user"><span>${escapeHtml(String(name))}</span>
        <button class="btn ghost small" id="logout">Se déconnecter</button></div>
    </header>
    <main class="content" id="prices"></main>`;
  app.querySelector('#logout')!.addEventListener('click', () => void supabase.auth.signOut());
  mountPrices(app.querySelector<HTMLElement>('#prices')!, { id: session.user.id });
}

function renderMessage(msg: string) {
  app.innerHTML = `<main class="gate">${brand}<p class="error">${escapeHtml(msg)}</p>
    <button class="btn" onclick="location.reload()">Recharger</button></main>`;
}
