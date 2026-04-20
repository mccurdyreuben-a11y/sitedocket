import React from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

function Spinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950">
      <div
        className="h-10 w-10 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-400"
        aria-hidden
      />
      <span className="sr-only">Loading</span>
    </div>
  );
}

/**
 * Requires authentication. Optionally restricts by role(s).
 * @param {object} props
 * @param {React.ReactNode} props.children
 * @param {'contractor' | 'sub' | null} [props.allowedRole]
 */
export function ProtectedRoute({ children, allowedRole = null }) {
  const { user, profile, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <Spinner />;
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!profile) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-950 px-4 text-center text-slate-200">
        <p className="text-lg font-medium">Profile not found</p>
        <p className="max-w-md text-sm text-slate-400">
          Your account exists but there is no profile row in the database. Make
          sure the <code className="text-emerald-400">users</code> table exists
          and the user&apos;s role and name are stored in signup metadata, then
          sign in again.
        </p>
        <Link
          to="/login"
          className="text-sm font-medium text-emerald-400 hover:text-emerald-300"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  if (allowedRole && profile.role !== allowedRole) {
    const fallback = profile.role === 'contractor' ? '/dashboard' : '/scan';
    return <Navigate to={fallback} replace />;
  }

  return children;
}
