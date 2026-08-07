import { createHash, randomBytes } from "node:crypto";

import { AppError } from "../utils/errors.js";

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: Date;
}

interface AccessToken {
  expiresAt: Date;
}

interface RefreshToken {
  clientId: string;
}

export interface IssuedTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export class OAuthStore {
  private readonly authorizationCodes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, AccessToken>();
  private readonly refreshTokens = new Map<string, RefreshToken>();

  public createAuthorizationCode(params: {
    clientId: string;
    redirectUri: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    now: Date;
  }): string {
    this.prune(params.now);

    const code = randomBytes(24).toString("base64url");
    this.authorizationCodes.set(code, {
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      expiresAt: new Date(params.now.getTime() + 5 * 60 * 1000)
    });

    return code;
  }

  public exchangeAuthorizationCode(params: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier?: string;
    now: Date;
  }): IssuedTokenSet {
    this.prune(params.now);

    const entry = this.authorizationCodes.get(params.code);
    this.authorizationCodes.delete(params.code);

    if (!entry) {
      throw new AppError("INVALID_GRANT", "Authorization code is invalid or expired.", 400);
    }

    if (entry.clientId !== params.clientId || entry.redirectUri !== params.redirectUri) {
      throw new AppError("INVALID_GRANT", "Authorization code does not match this client.", 400);
    }

    if (entry.codeChallenge && !matchesPkceChallenge(entry, params.codeVerifier)) {
      throw new AppError("INVALID_GRANT", "PKCE verification failed.", 400);
    }

    return this.issueTokenSet(params.clientId, params.now);
  }

  public refreshAccessToken(params: {
    refreshToken: string;
    clientId: string;
    now: Date;
  }): IssuedTokenSet {
    this.prune(params.now);

    const entry = this.refreshTokens.get(params.refreshToken);
    if (!entry || entry.clientId !== params.clientId) {
      throw new AppError("INVALID_GRANT", "Refresh token is invalid.", 400);
    }

    this.refreshTokens.delete(params.refreshToken);
    return this.issueTokenSet(params.clientId, params.now);
  }

  public hasAccessToken(token: string, now: Date): boolean {
    this.prune(now);

    const entry = this.accessTokens.get(token);
    return Boolean(entry && entry.expiresAt.getTime() > now.getTime());
  }

  private issueTokenSet(clientId: string, now: Date): IssuedTokenSet {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const expiresIn = 60 * 60;

    this.accessTokens.set(accessToken, {
      expiresAt: new Date(now.getTime() + expiresIn * 1000)
    });
    this.refreshTokens.set(refreshToken, { clientId });

    return {
      accessToken,
      refreshToken,
      expiresIn
    };
  }

  private prune(now: Date): void {
    for (const [code, entry] of this.authorizationCodes.entries()) {
      if (entry.expiresAt.getTime() <= now.getTime()) {
        this.authorizationCodes.delete(code);
      }
    }

    for (const [token, entry] of this.accessTokens.entries()) {
      if (entry.expiresAt.getTime() <= now.getTime()) {
        this.accessTokens.delete(token);
      }
    }
  }
}

function matchesPkceChallenge(entry: AuthorizationCode, codeVerifier: string | undefined): boolean {
  if (!codeVerifier) {
    return false;
  }

  if (!entry.codeChallengeMethod || entry.codeChallengeMethod === "plain") {
    return codeVerifier === entry.codeChallenge;
  }

  if (entry.codeChallengeMethod === "S256") {
    const digest = createHash("sha256").update(codeVerifier).digest("base64url");
    return digest === entry.codeChallenge;
  }

  return false;
}
