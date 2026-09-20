import { stopServers } from './server'

export default function globalTeardown(): void { stopServers() }
