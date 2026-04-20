import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function LogoutButton({ className = '' }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    const { error } = await signOut();
    setPending(false);
    if (!error) {
      navigate('/login', { replace: true });
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      className={`rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 disabled:opacity-50 ${className}`}
    >
      {pending ? 'Signing out…' : 'Log out'}
    </button>
  );
}
