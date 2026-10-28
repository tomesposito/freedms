import type { Vehicle, VehicleStatus } from '@freedms/shared';

export async function fetchAllVehicles<T extends Vehicle>(api: <R>(path: string) => Promise<R>, query: {status?: VehicleStatus; search?: string} = {}): Promise<T[]> {
  const vehicles: T[] = [];
  const params = new URLSearchParams({...query, limit: '500'});
  for (let offset = 0; ; offset += 500) {
    params.set('offset', String(offset));
    const page = await api<T[]>(`/vehicles?${params}`);
    vehicles.push(...page);
    if (page.length < 500) return vehicles;
  }
}
