import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { supabase } from '../lib/supabaseClient';

const AuthContext = createContext(null);

async function fetchProfile(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, name, company_name, role, created_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Create profile row from auth user_metadata (used after email confirmation). */
async function ensureUserProfileFromMetadata(user) {
  const meta = user.user_metadata || {};
  const name = meta.full_name;
  const role = meta.role;
  if (!name || !role) return null;

  const { error } = await supabase.from('users').insert({
    id: user.id,
    email: user.email,
    name,
    company_name: meta.company_name || null,
    role,
  });

  if (error) {
    if (error.code === '23505') {
      return fetchProfile(user.id);
    }
    throw error;
  }

  return fetchProfile(user.id);
}

async function loadProfileForCurrentUser() {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user?.id) return null;

  let p = await fetchProfile(user.id);
  if (p) return p;

  return ensureUserProfileFromMetadata(user);
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshProfile = useCallback(async () => {
    const p = await loadProfileForCurrentUser();
    setProfile(p);
    return p;
  }, []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      if (!mounted) return;
      setSession(s);
      if (s?.user) {
        try {
          const p = await loadProfileForCurrentUser();
          if (mounted) setProfile(p);
        } catch (e) {
          console.error(e);
          if (mounted) setProfile(null);
        }
      } else {
        setProfile(null);
      }
      if (mounted) setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, s) => {
      setSession(s);
      if (s?.user) {
        try {
          const p = await loadProfileForCurrentUser();
          setProfile(p);
        } catch (e) {
          console.error(e);
          setProfile(null);
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) return { error };
    await refreshProfile();
    return { error: null };
  }, [refreshProfile]);

  const signUp = useCallback(async (email, password, fullName, companyName, role) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          company_name: companyName || null,
          role,
        },
      },
    });
    if (error) return { error, needsEmailConfirmation: false };

    if (data.session?.user) {
      const { error: insertError } = await supabase.from('users').insert({
        id: data.user.id,
        email,
        name: fullName,
        company_name: companyName || null,
        role,
      });
      if (insertError) return { error: insertError, needsEmailConfirmation: false };
      await refreshProfile();
      return { error: null, needsEmailConfirmation: false };
    }

    return { error: null, needsEmailConfirmation: true };
  }, [refreshProfile]);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (!error) {
      setProfile(null);
      setSession(null);
    }
    return { error };
  }, []);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      loading,
      signIn,
      signUp,
      signOut,
      refreshProfile,
    }),
    [session, profile, loading, signIn, signUp, signOut, refreshProfile]
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
