import { Rect } from './types';

export interface PerceptualSnapshot {
    text: string;
    cursorBox?: Rect | null;
    pageTitle?: string;
    pageUrl?: string;
}

export type UserActionType = 'KEY_PRESS' | 'CLICK' | 'TYPE' | 'GO_BACK';

export interface UserAction {
    type: UserActionType;
    key?: string;
    text?: string;
    targetId?: string;
    x?: number;
    y?: number;
}

export interface ActionResult {
    success: boolean;
    message?: string;
    snapshot: PerceptualSnapshot;
}
