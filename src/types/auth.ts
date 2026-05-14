export type DeviceToken = {
  id: string;
  salt: string;
  hash: string;
  createdAt: string;
  lastUsedAt: string;
};

export type ApiKey = {
  id: string;
  label: string;
  keySalt: string;
  keyHash: string;
  createdAt: string;
};

export type AuthData = {
  passwordSalt: string;
  passwordHash: string;
  tokens: DeviceToken[];
  apiKeys?: ApiKey[];
};

export type AuthGuardLoginRequest = {
  ip: string;
  timestamp: string;
};

export type AuthGuardFailedLogin = {
  ip: string;
  timestamp: string;
};

export type AuthGuardIpBan = {
  ip: string;
  bannedAt: string;
  expiresAt: string;
  reason: string;
};

export type AuthGuardEvent = {
  type:
    | "login-requested"
    | "login-failed"
    | "login-succeeded"
    | "login-blocked"
    | "ip-banned"
    | "ip-unbanned"
    | "login-enabled"
    | "login-disabled"
    | "login-locked";
  ip: string;
  timestamp: string;
  detail: string;
};

export type AuthGuardData = {
  loginEnabled: boolean;
  globalLock: {
    active: boolean;
    lockedAt: string | null;
    expiresAt: string | null;
    reason: string | null;
  };
  bannedIps: AuthGuardIpBan[];
};

export type AuthGuardRuntime = {
  loginRequests: AuthGuardLoginRequest[];
  failedLogins: AuthGuardFailedLogin[];
};

export type AuthGuardSummary = {
  loginEnabled: boolean;
  globalLockActive: boolean;
  globalLockAt: string | null;
  globalLockExpiresAt: string | null;
  globalLockReason: string | null;
  recentLoginRequestCount: number;
  bannedIpCount: number;
};

export type ViewerInfo = {
  isOwner: boolean;
  commenterName: string | null;
  hasCommenterIdentity: boolean;
};

export type ViewerContext = {
  viewer: ViewerInfo;
  commenter: {
    id: string | null;
    name: string | null;
  };
};
