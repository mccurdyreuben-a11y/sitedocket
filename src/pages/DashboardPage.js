import React from 'react';
import { LogoutButton } from '../components/LogoutButton';
import { useAuth } from '../context/AuthContext';

export function DashboardPage() {
  const { profile } = useAuth();

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-4 sm:px-6">
        <div>
          <h1 className="text-lg font-semibold text-white">Dashboard</h1>
          <p className="text-sm text-slate-400">
            {profile?.name}
            {profile?.company_name ? ` · ${profile.company_name}` : ''}
          </p>
        </div>
        <LogoutButton />
      </header>
      <main className="p-4 sm:p-6">
        <p className="text-slate-300">
          Main contractor home — add your site list and dockets here.
        </p>
      </main>
    </div>
  );
}
