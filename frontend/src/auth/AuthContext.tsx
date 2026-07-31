import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, tokenStorage, type User } from '../api/client';

interface AuthContextValue {
  user: User | null;
  /** True until the stored token has been checked, so routes do not flash. */
  initialising: boolean;
  signup: (email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [initialising, setInitialising] = useState(true);

  // A stored token may be expired, or name a deleted account. Rather than
  // trusting it, ask the API who it belongs to — /api/auth/me loads the user
  // rather than decoding the token, so a deleted account fails here.
  useEffect(() => {
    if (tokenStorage.get() === null) {
      setInitialising(false);
      return;
    }

    api
      .me()
      .then((response) => setUser(response.user))
      .catch(() => {
        tokenStorage.clear();
        setUser(null);
      })
      .finally(() => setInitialising(false));
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    const response = await api.signup(email, password);
    tokenStorage.set(response.token);
    setUser(response.user);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const response = await api.login(email, password);
    tokenStorage.set(response.token);
    setUser(response.user);
  }, []);

  const logout = useCallback(() => {
    tokenStorage.clear();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, initialising, signup, login, logout }),
    [user, initialising, signup, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }
  return context;
}
