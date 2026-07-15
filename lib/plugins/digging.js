const { performance } = require('perf_hooks')
const { createDoneTask, createTask } = require('../promise_utils')
const BlockFaces = require('prismarine-world').iterators.BlockFace
const { Vec3 } = require('vec3')

module.exports = inject

function inject (bot) {
  let swingInterval = null
  let waitTimeout = null

  let diggingTask = createDoneTask()
  let diggingActive = false
  let diggingStartedAt = null
  let digSequence = 0
  let digRetryCount = 0
  let currentDigBlock = null
  let currentDigWaitTime = 0
  let currentDigEventName = null
  const MAX_DIG_RETRIES = 5

  bot.targetDigBlock = null
  bot.targetDigFace = null
  bot.lastDigTime = null

  const hasDigSequence = bot.registry && bot.registry.isNewerOrEqualTo && bot.registry.isNewerOrEqualTo('1.19')
  const serverValidatesDigTiming = bot.registry && bot.registry.isNewerOrEqualTo && bot.registry.isNewerOrEqualTo('1.20.2')

  async function dig (block, forceLook, digFace) {
    if (block === null || block === undefined) {
      throw new Error('dig was called with an undefined or null block')
    }
    if (diggingActive) {
      throw new Error('Digging already in progress')
    }

    diggingActive = true
    try {
    if (!digFace || typeof digFace === 'function') {
      digFace = 'auto'
    }

    const waitTime = bot.digTime(block)
    if (waitTime === Infinity) {
      throw new Error(`dig time for ${block?.name ?? block} is Infinity`)
    }

    bot.targetDigFace = 1

    if (forceLook !== 'ignore') {
      if (digFace?.x || digFace?.y || digFace?.z) {
        if (digFace.x) {
          bot.targetDigFace = digFace.x > 0 ? BlockFaces.EAST : BlockFaces.WEST
        } else if (digFace.y) {
          bot.targetDigFace = digFace.y > 0 ? BlockFaces.TOP : BlockFaces.BOTTOM
        } else if (digFace.z) {
          bot.targetDigFace = digFace.z > 0 ? BlockFaces.SOUTH : BlockFaces.NORTH
        }
        await bot.lookAt(
          block.position.offset(0.5, 0.5, 0.5).offset(digFace.x * 0.5, digFace.y * 0.5, digFace.z * 0.5),
          forceLook
        )
      } else if (digFace === 'raycast') {
        const dx = bot.entity.position.x - (block.position.x + 0.5)
        const dy = bot.entity.position.y + bot.entity.eyeHeight - (block.position.y + 0.5)
        const dz = bot.entity.position.z - (block.position.z + 0.5)
        const visibleFaces = {
          y: Math.sign(Math.abs(dy) > 0.5 ? dy : 0),
          x: Math.sign(Math.abs(dx) > 0.5 ? dx : 0),
          z: Math.sign(Math.abs(dz) > 0.5 ? dz : 0)
        }
        const validFaces = []
        const closerBlocks = []
        for (const i in visibleFaces) {
          if (!visibleFaces[i]) continue
          const targetPos = block.position.offset(
            0.5 + (i === 'x' ? visibleFaces[i] * 0.5 : 0),
            0.5 + (i === 'y' ? visibleFaces[i] * 0.5 : 0),
            0.5 + (i === 'z' ? visibleFaces[i] * 0.5 : 0)
          )
          const startPos = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
          const rayBlock = bot.world.raycast(startPos, targetPos.clone().subtract(startPos).normalize(), 5)
          if (rayBlock) {
            if (startPos.distanceTo(rayBlock.intersect) < startPos.distanceTo(targetPos)) {
              closerBlocks.push(rayBlock)
              continue
            }
            const rayPos = rayBlock.position
            if (
              rayPos.x === block.position.x &&
              rayPos.y === block.position.y &&
              rayPos.z === block.position.z
            ) {
              validFaces.push({
                face: rayBlock.face,
                targetPos: rayBlock.intersect
              })
            }
          }
        }

        if (validFaces.length > 0) {
          let closest
          let distSqrt = 999
          for (const i in validFaces) {
            const tPos = validFaces[i].targetPos
            const cDist = new Vec3(tPos.x, tPos.y, tPos.z).distanceSquared(
              bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
            )
            if (distSqrt > cDist) {
              closest = validFaces[i]
              distSqrt = cDist
            }
          }
          await bot.lookAt(closest.targetPos, forceLook)
          bot.targetDigFace = closest.face
        } else if (closerBlocks.length === 0 && block.shapes.length === 0) {
          await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), forceLook)
        } else {
          throw new Error('Block not in view')
        }
      } else {
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), forceLook)
      }
    }

    if (bot.targetDigBlock) bot.stopDigging()

    digRetryCount = 0
    currentDigBlock = block
    currentDigWaitTime = waitTime
    diggingTask = createTask()

    startDigAttempt()

    currentDigEventName = `blockUpdate:${block.position}`
    bot.on(currentDigEventName, onBlockUpdate)

    const currentBlock = block
    bot.stopDigging = () => {
      if (!bot.targetDigBlock) return
      const stoppedBecauseOfNewDigRequest = !currentBlock.position.equals(bot.targetDigBlock.position)
      const cancellationDiggingFace = !stoppedBecauseOfNewDigRequest ? bot.targetDigFace : 0

      bot.removeListener(currentDigEventName, onBlockUpdate)
      clearInterval(swingInterval)
      clearTimeout(waitTimeout)
      swingInterval = null
      waitTimeout = null
      diggingStartedAt = null
      writeBlockDig(1, bot.targetDigBlock.position, cancellationDiggingFace)
      const block = bot.targetDigBlock
      bot.targetDigBlock = null
      bot.targetDigFace = null
      currentDigBlock = null
      currentDigWaitTime = 0
      currentDigEventName = null
      bot.lastDigTime = performance.now()
      bot.emit('diggingAborted', block)
      bot.stopDigging = noop
      diggingTask.cancel(new Error('Digging aborted'))
    }

    await diggingTask.promise
    } finally {
      diggingActive = false
    }
  }

  function writeBlockDig (status, location, face) {
    const packet = {
      status,
      location,
      face
    }
    if (hasDigSequence) {
      packet.sequence = digSequence++
    }
    bot._client.write('block_dig', packet)
  }

  function startDigAttempt () {
    digRetryCount++
    if (digRetryCount > MAX_DIG_RETRIES) {
      cleanupDig()
      return diggingTask.cancel(new Error('Digging failed after max retries'))
    }

    clearInterval(swingInterval)
    clearTimeout(waitTimeout)
    swingInterval = null
    waitTimeout = null

    writeBlockDig(0, currentDigBlock.position, bot.targetDigFace)

    const timerWait = serverValidatesDigTiming ? (currentDigWaitTime + 50) : currentDigWaitTime
    waitTimeout = setTimeout(finishDigging, timerWait)
    bot.targetDigBlock = currentDigBlock
    diggingStartedAt = performance.now()
    bot.swingArm()
    swingInterval = setInterval(() => {
      bot.swingArm()
    }, 350)
  }

  function finishDigging () {
    clearInterval(swingInterval)
    clearTimeout(waitTimeout)
    swingInterval = null
    waitTimeout = null
    if (bot.targetDigBlock) {
      writeBlockDig(2, bot.targetDigBlock.position, bot.targetDigFace)
    }
    bot.lastDigTime = performance.now()

    if (!serverValidatesDigTiming) {
      resolveDigSuccess()
      return
    }

    waitTimeout = setTimeout(() => {
      if (!bot.targetDigBlock) return
      const currentBlockAtPos = bot.blockAt(currentDigBlock.position)
      if (currentBlockAtPos && currentBlockAtPos.type === 0) {
        resolveDigSuccess()
      } else if (bot.targetDigBlock) {
        startDigAttempt()
      }
    }, 1000)
  }

  function resolveDigSuccess () {
    bot.removeListener(currentDigEventName, onBlockUpdate)
    clearInterval(swingInterval)
    clearTimeout(waitTimeout)
    swingInterval = null
    waitTimeout = null
    bot.targetDigBlock = null
    bot.targetDigFace = null
    bot.lastDigTime = performance.now()
    diggingStartedAt = null
    bot.stopDigging = noop
    const resolvedBlock = currentDigBlock
    currentDigBlock = null
    currentDigWaitTime = 0
    currentDigEventName = null
    bot.emit('diggingCompleted', resolvedBlock)
    diggingTask.finish()
  }

  function cleanupDig () {
    bot.removeListener(currentDigEventName, onBlockUpdate)
    clearInterval(swingInterval)
    clearTimeout(waitTimeout)
    swingInterval = null
    waitTimeout = null
    bot.targetDigBlock = null
    bot.targetDigFace = null
    bot.stopDigging = noop
    diggingStartedAt = null
    currentDigBlock = null
    currentDigWaitTime = 0
    currentDigEventName = null
  }

  function onBlockUpdate (oldBlock, newBlock) {
    if (!newBlock) return
    if (newBlock.type !== 0 && newBlock.type === currentDigBlock.type) {
      if (!serverValidatesDigTiming) return
      const elapsed = diggingStartedAt !== null ? performance.now() - diggingStartedAt : 0
      if (elapsed > 500) {
        startDigAttempt()
      }
      return
    }
    resolveDigSuccess()
  }

  bot.on('death', () => {
    try {
      bot.removeAllListeners('diggingAborted')
      bot.removeAllListeners('diggingCompleted')
      bot.stopDigging()
    } catch (_) {}
  })

  function canDigBlock (block, reach = 5.1) {
    return (
      block &&
      block.diggable &&
      block.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, bot.entity.eyeHeight, 0)) <= reach
    )
  }

  function digTime (block) {
    let type = null
    let enchantments = []

    const normalizeEnchantments = (value) => {
      if (Array.isArray(value)) return value
      if (!value || typeof value !== 'object') return []

      const enchantments = []
      const pushEnchant = (name, lvl) => {
        const level = Number(lvl)
        if (typeof name === 'string' && Number.isFinite(level)) {
          enchantments.push({ name: name.replace(/^minecraft:/, ''), lvl: level })
        }
      }

      for (const source of [value.levels, value.enchantments, value]) {
        if (!source || typeof source !== 'object') continue
        for (const [name, data] of Object.entries(source)) {
          if (typeof data === 'number') pushEnchant(name, data)
          else if (data && typeof data === 'object') pushEnchant(name, data.level ?? data.lvl)
        }
      }

      return enchantments
    }

    const currentlyHeldItem = bot.heldItem
    if (currentlyHeldItem) {
      type = currentlyHeldItem.type
      enchantments = normalizeEnchantments(currentlyHeldItem.enchants)
    }

    const headEquipmentSlot = bot.getEquipmentDestSlot('head')
    const headEquippedItem = bot.inventory.slots[headEquipmentSlot]
    if (headEquippedItem) {
      const helmetEnchantments = normalizeEnchantments(headEquippedItem.enchants)
      enchantments = enchantments.concat(helmetEnchantments)
    }

    const creative = bot.game.gameMode === 'creative'
    return block.digTime(
      type,
      creative,
      ['water', 'flowing_water'].includes(bot._getBlockAtEyeLevel()?.name),
      !bot.entity.onGround,
      enchantments,
      bot.entity.effects
    )
  }

  bot._getBlockAtEyeLevel = () => bot.entity.position && bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
  bot.dig = dig
  bot.stopDigging = noop
  bot.canDigBlock = canDigBlock
  bot.digTime = digTime
}

function noop (err) {
  if (err) throw err
}
