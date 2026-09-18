// services/pollingService.ts

const TARGET_POLL_INTERVAL_MS = 3000;

type TargetLocationApiResponse =
    | {
        ok: true;
        data: {
            usersId: number;
            takecareId: number;
            lat: number;
            lng: number;
            target_sample_id?: string | null;
            sourceTimestamp: string | null;
            status: number;
            battery: number;
        };
    }
    | {
        ok: false;
        error: string;
    };

export type PolledLocation = {
    latitude: number;
    longitude: number;
    targetSampleId: string | null;
    sourceTimestamp: string | null;
    status: number;
    battery: number;
};

export class AdaptivePollingService {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private abortController: AbortController | null = null;
    private isRunning = false;
    private requestGeneration = 0;
    private usersId: number;
    private takecareId: number;
    private onLocationUpdate: (location: PolledLocation) => void;

    constructor(
        usersId: number,
        takecareId: number,
        onLocationUpdate: (location: PolledLocation) => void,
    ) {
        assertPositiveInteger(usersId, 'usersId');
        assertPositiveInteger(takecareId, 'takecareId');

        this.usersId = usersId;
        this.takecareId = takecareId;
        this.onLocationUpdate = onLocationUpdate;
    }

    public start(): void {
        if (this.isRunning) return;

        this.isRunning = true;
        this.requestGeneration += 1;
        void this.poll();
    }

    private async poll(): Promise<void> {
        if (!this.isRunning) return;

        if (this.abortController) {
            return;
        }

        const generation = this.requestGeneration;
        const controller = new AbortController();
        this.abortController = controller;

        try {
            const response = await fetch(this.buildUrl(), {
                signal: controller.signal,
            });

            if (!response.ok) {
                console.warn('[TargetPolling] Request failed', { status: response.status });
                return;
            }

            const payload: unknown = await response.json();
            if (!isTargetLocationApiResponse(payload)) {
                console.warn('[TargetPolling] Invalid response payload');
                return;
            }

            if (!payload.ok) {
                console.warn('[TargetPolling] API returned error', { error: payload.error });
                return;
            }

            const data = payload.data;
            if (data.usersId !== this.usersId || data.takecareId !== this.takecareId) {
                console.warn('[TargetPolling] Response identity mismatch', {
                    expectedUsersId: this.usersId,
                    expectedTakecareId: this.takecareId,
                    receivedUsersId: data.usersId,
                    receivedTakecareId: data.takecareId,
                });
                return;
            }

            if (!Number.isFinite(data.lat) || !Number.isFinite(data.lng)) {
                console.warn('[TargetPolling] Invalid coordinates');
                return;
            }

            if (
                !this.isRunning ||
                generation !== this.requestGeneration ||
                controller.signal.aborted
            ) {
                return;
            }

            this.onLocationUpdate({
                latitude: data.lat,
                longitude: data.lng,
                targetSampleId: data.target_sample_id ?? null,
                sourceTimestamp: data.sourceTimestamp,
                status: data.status,
                battery: data.battery,
            });
        } catch (error) {
            if (isAbortError(error)) {
                return;
            }

            console.warn('[TargetPolling] Request error');
        } finally {
            if (this.abortController === controller) {
                this.abortController = null;
            }

            if (this.isRunning && generation === this.requestGeneration) {
                this.scheduleNextPoll();
            }
        }
    }

    private buildUrl(): string {
        return `/api/navigate/target-location?users_id=${encodeURIComponent(String(this.usersId))}` +
            `&takecare_id=${encodeURIComponent(String(this.takecareId))}`;
    }

    private scheduleNextPoll(): void {
        if (!this.isRunning) return;

        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.poll();
        }, TARGET_POLL_INTERVAL_MS);
    }

    public stop(): void {
        this.isRunning = false;
        this.requestGeneration += 1;

        if (this.timer) clearTimeout(this.timer);
        this.timer = null;

        this.abortController?.abort();
        this.abortController = null;
    }
}

function assertPositiveInteger(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
}

function isTargetLocationApiResponse(value: unknown): value is TargetLocationApiResponse {
    if (!isRecord(value) || typeof value.ok !== 'boolean') {
        return false;
    }

    if (!value.ok) {
        return typeof value.error === 'string';
    }

    const data = value.data;
    return isRecord(data) &&
        typeof data.usersId === 'number' &&
        typeof data.takecareId === 'number' &&
        typeof data.lat === 'number' &&
        typeof data.lng === 'number' &&
        (data.target_sample_id === undefined || data.target_sample_id === null || typeof data.target_sample_id === 'string') &&
        (typeof data.sourceTimestamp === 'string' || data.sourceTimestamp === null) &&
        typeof data.status === 'number' &&
        typeof data.battery === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}
