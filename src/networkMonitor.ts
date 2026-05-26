import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

// Kuuntelee verkkoyhteyden muutoksia
export function onNetworkChange(
  callback: (isConnected: boolean) => void
) {
  const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
    callback(state.isConnected ?? false);
  });

  return unsubscribe;
}

// Tarkistaa verkkoyhteyden tilan
export async function checkConnection(): Promise<boolean> {
  const state = await NetInfo.fetch();
  return state.isConnected ?? false;
}