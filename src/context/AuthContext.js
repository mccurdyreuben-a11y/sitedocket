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

async function upsertUserProfile({ id, email, name, companyName, role }) {
  const { error } = await supabase.from('users').upsert(
    {
      id,
      email,
      name,
      company_name: companyName || null,
      role,
    },
    { onConflict: 'id' }
  );

  if (error) throw error;
  return fetchProfile(id);
}

/** Create profile row from auth user_metadata (used after email confirmation). */
async function ensureUserProfileFromMetadata(user) {
  const meta = user.user_metadata || {};
  const name = meta.full_name;
  const role = meta.role;
  if (!name || !role) return null;

  return upsertUserProfile({
    id: user.id,
    email: user.email,
    name,
    companyName: meta.company_name || null,
    role,
  });
}

async function loadProfileForUser(user) {
  if (!user?.id) return null;
  let p = await fetchProfile(user.id);
  if (p) return p;

  return ensureUserProfileFromMetadata(user);
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshProfile = useCallback(async () => {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error || !user?.id) {
      setProfile(null);
      return null;
    }
    const p = await loadProfileForUser(user);
    setProfile(p);
    return p;
  }, []);

  useEffect(() => {
    let mounted = true;
    const applyAuthState = async (s) => {
      if (!mounted) return;

      setSession(s);

      if (!s?.user) {
        setProfile(null);
        setLoading(false);
        return;
      }

      try {
        const p = await loadProfileForUser(s.user);
        if (mounted) setProfile(p);
      } catch (e) {
        console.error(e);
        if (mounted) setProfile(null);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    const initializeSession = async () => {
      try {
        const {
          data: { session: s },
        } = await supabase.auth.getSession();
        await applyAuthState(s);
      } catch (e) {
        console.error(e);
        if (mounted) {
          setSession(null);
          setProfile(null);
          setLoading(false);
        }
      }
    };

    void initializeSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      void applyAuthState(s);
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

    const authUser = data.user || data.session?.user;
    if (authUser?.id) {
      try {
        await upsertUserProfile({
          id: authUser.id,
          email,
          name: fullName,
          companyName: companyName || null,
          role,
        });
      } catch (profileError) {
        return { error: profileError, needsEmailConfirmation: false };
      }
    }

    if (data.session?.user) {
      await refreshProfile();
      return { error: null, needsEmailConfirmation: false };
    }

    return { error: null, needsEmailConfirmation: true };
  }, [refreshProfile]);

  const signOut = useCallback(async () => {
    try {
      const { error } = await supabase.auth.signOut();
      return { error };
    } finally {
      // Always clear local auth state so UI doesn't hang
      setProfile(null);
      setSession(null);
      setLoading(false);
    }
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
