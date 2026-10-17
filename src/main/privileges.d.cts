export interface PermissionStatus {
  available: boolean;
  elevated: boolean;
  uiAccess: boolean;
  processId?: number;
  sessionId?: number;
  error?: string;
  errorCode?: number;
}
export interface RelaunchResult {
  started: boolean;
  cancelled: boolean;
  processId?: number;
  elevated?: boolean;
  uiAccess?: boolean;
  error?: string;
  errorCode?: number;
}
export interface PrivilegeService {
  getStatus(pid?: number): Promise<PermissionStatus>;
  requestRelaunch(request: { uiAccess: boolean }): Promise<RelaunchResult>;
}
export function createPrivilegeService(options?: {
  helperPath?: string;
  executable?: string;
  baseArgs?: string[];
  workingDirectory?: string;
}): PrivilegeService;
export function getStatus(pid?: number): Promise<PermissionStatus>;
export function requestRelaunch(request: { uiAccess: boolean }): Promise<RelaunchResult>;
export function quoteWindowsArgument(value: string): string;
