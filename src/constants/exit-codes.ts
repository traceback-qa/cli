export const EXIT_SUCCESS = 0 as const;
export const EXIT_USER_ERROR = 1 as const;
export const EXIT_UNEXPECTED = 2 as const;
export const EXIT_AUTH_ERROR = 4 as const;
export const EXIT_NETWORK_ERROR = 5 as const;
export const EXIT_API_ERROR = 6 as const;
export const EXIT_NO_CONFIG = 78 as const;
export const EXIT_PERMISSION_DENIED = 77 as const;

export type ExitCode =
  | typeof EXIT_SUCCESS
  | typeof EXIT_USER_ERROR
  | typeof EXIT_UNEXPECTED
  | typeof EXIT_AUTH_ERROR
  | typeof EXIT_NETWORK_ERROR
  | typeof EXIT_API_ERROR
  | typeof EXIT_NO_CONFIG
  | typeof EXIT_PERMISSION_DENIED;
