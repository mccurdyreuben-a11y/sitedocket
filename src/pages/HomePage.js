import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Sends authenticated users to the right home; public landing can be swapped later.
 */
export function HomePage() {
  const { user, profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <div
          className="h-10 w-10 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-400"
          aria-hidden
        />
      </div>
    );
  }

  if (!user || !profile) {
    return <Navigate to="/login" replace />;
  }

  const dest = profile.role === 'contractor' ? '/dashboard' : '/scan';
  return <Navigate to={dest} replace />;
}
