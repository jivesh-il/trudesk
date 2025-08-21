/*
 *       .                             .o8                     oooo
 *    .o8                             "888                     `888
 *  .o888oo oooo d8b oooo  oooo   .oooo888   .ooooo.   .oooo.o  888  oooo
 *    888   `888""8P `888  `888  d88' `888  d88' `88b d88(  "8  888 .8P'
 *    888    888      888   888  888   888  888ooo888 `"Y88b.   888888.
 *    888 .  888      888   888  888   888  888    .o o.  )88b  888 `88b.
 *    "888" d888b     `V88V"V8P' `Y8bod88P" `Y8bod8P' 8""888P' o888o o888o
 *  ========================================================================
 *  Author:     Chris Brame
 *  Updated:    2/14/19 12:05 AM
 *  Copyright (c) 2014-2019. All rights reserved.
 */

const _ = require('lodash')
const async = require('async')
const logger = require('../../../logger')
const apiUtils = require('../apiUtils')
const Models = require('../../../models')
const permissions = require('../../../permissions')
const ticketStatusSchema = require('../../../models/ticketStatus')

const ticketsV2 = {}

ticketsV2.create = async function (req, res) {
  const postTicket = req.body
  if (!postTicket) return apiUtils.sendApiError_InvalidPostData(res)

  try {
    // Validate required fields
    if (!postTicket.subject || !postTicket.issue) {
      return apiUtils.sendApiError(res, 400, 'Subject and issue are required')
    }

    // Get all available groups for user to select from
    let availableGroups = []
    
    // If user is admin or agent, show all groups
    if (req.user.role.isAdmin || req.user.role.isAgent) {
      const Group = require('../../../models/group')
      availableGroups = await Group.getAllGroups()
    } else {
      // For regular users, also show all groups (modified behavior)
      const Group = require('../../../models/group')
      availableGroups = await Group.getAllGroups()
    }

    // If no group is specified, use the first available group as default
    let selectedGroup = null
    if (postTicket.group) {
      selectedGroup = availableGroups.find(g => g._id.toString() === postTicket.group.toString())
      if (!selectedGroup) {
        return apiUtils.sendApiError(res, 400, 'Invalid group specified')
      }
    } else {
      // Use first available group as default
      selectedGroup = availableGroups[0]
      if (!selectedGroup) {
        return apiUtils.sendApiError(res, 400, 'No groups available')
      }
    }

    // Get default ticket status
    const TicketStatus = require('../../../models/ticketStatus')
    const defaultStatus = await TicketStatus.findOne({ order: 0 })
    if (!defaultStatus) {
      return apiUtils.sendApiError(res, 500, 'Default ticket status not found')
    }

    // Get default ticket type
    const TicketType = require('../../../models/tickettype')
    const defaultType = await TicketType.findOne({})
    if (!defaultType) {
      return apiUtils.sendApiError(res, 500, 'Default ticket type not found')
    }

    // Check if group has only one member for automatic assignment
    let assignee = null
    if (selectedGroup.members && selectedGroup.members.length === 1) {
      assignee = selectedGroup.members[0]
    }

    // Create ticket
    const Ticket = require('../../../models/ticket')
    
    // Debug: Log the file field
    console.log('File field from request:', postTicket.file)
    
    const ticket = new Ticket({
      owner: req.user._id,
      group: selectedGroup._id,
      assignee: assignee,
      type: postTicket.type || defaultType._id, // Allow custom type or use default
      status: defaultStatus._id,
      priority: defaultType.priorities && defaultType.priorities.length > 0 ? defaultType.priorities[0] : null,
      subject: postTicket.subject,
      issue: postTicket.issue,
      description: postTicket.description, // Add the description field
      file: postTicket.file, // Add the file field
      history: [{
        action: 'ticket:created',
        description: 'Ticket was created.',
        owner: req.user._id
      }],
      subscribers: [req.user._id]
    })
    
    // Debug: Log the ticket object before saving
    console.log('Ticket object before save:', JSON.stringify(ticket, null, 2))

    // Save ticket
    const savedTicket = await ticket.save()
    
    // Populate ticket with related data
    await savedTicket.populate('group owner priority type status assignee')

    // Emit ticket created event
    const emitter = require('../../../emitter')
    emitter.emit('ticket:created', {
      hostname: req.headers.host,
      socketId: '',
      ticket: savedTicket
    })

    return apiUtils.sendApiSuccess(res, { ticket: savedTicket })

  } catch (error) {
    logger.warn(error)
    return apiUtils.sendApiError(res, 500, error.message)
  }
}

ticketsV2.get = async (req, res) => {
  const query = req.query
  const type = query.type || 'all'

  let limit = 50
  let page = 0

  try {
    limit = query.limit ? parseInt(query.limit) : limit
    page = query.page ? parseInt(query.page) : page
  } catch (e) {
    logger.warn(e)
    return apiUtils.sendApiError_InvalidPostData(res)
  }

  const queryObject = {
    limit,
    page
  }

  try {
    let groups = []
    if (req.user.role.isAdmin || req.user.role.isAgent) {
      const dbGroups = await Models.Department.getDepartmentGroupsOfUser(req.user._id)
      groups = dbGroups.map(g => g._id)
    } else {
      groups = await Models.Group.getAllGroupsOfUser(req.user._id)
    }

    const mappedGroups = groups.map(g => g._id)

    const statuses = await ticketStatusSchema.find({ isResolved: false })

    switch (type.toLowerCase()) {
      case 'active':
        queryObject.status = statuses.map(i => i._id.toString())
        break
      case 'assigned':
        queryObject.filter = {
          assignee: [req.user._id]
        }
        break
      case 'unassigned':
        queryObject.unassigned = true
        break
      case 'new':
        queryObject.status = [0]
        break
      case 'open':
        queryObject.status = [1]
        break
      case 'pending':
        queryObject.status = [2]
        break
      case 'closed':
        queryObject.status = [3]
        break
      case 'filter':
        try {
          queryObject.filter = JSON.parse(query.filter)
          queryObject.status = queryObject.filter.status
        } catch (error) {
          logger.warn(error)
        }
        break
    }

    // For regular users, include tickets they own regardless of group membership
    if (!permissions.canThis(req.user.role, 'tickets:viewall', false)) {
      // Get tickets owned by user regardless of group membership
      const userOwnedTickets = await Models.Ticket.find({
        $or: [
          { owner: req.user._id },
          { assignee: req.user._id }
        ],
        deleted: false
      }).populate('owner assignee subscribers comments.owner notes.owner history.owner', 'username fullname email role image title')
        .populate('assignee', 'username fullname email role image title')
        .populate('type tags status group')
        .sort({ uid: -1 })
        .skip(page * limit)
        .limit(limit)

      // Get group-based tickets for users who belong to groups
      let groupTickets = []
      if (mappedGroups.length > 0) {
        groupTickets = await Models.Ticket.getTicketsWithObject(mappedGroups, queryObject)
      }

      // Combine and deduplicate tickets
      const allTickets = [...userOwnedTickets, ...groupTickets]
      const uniqueTickets = allTickets.filter((ticket, index, self) => 
        index === self.findIndex(t => t._id.toString() === ticket._id.toString())
      )

      // Add overdue and escalate_to_admin fields to each ticket
      const moment = require('moment')
      const processedTickets = uniqueTickets.map(ticket => {
        const now = moment()
        const lastUpdate = ticket.updated ? moment(ticket.updated) : moment(ticket.date)
        const hoursSinceUpdate = now.diff(lastUpdate, 'hours')
        
        // Check for recent assignee activity in the last 48 hours
        let hasRecentAssigneeActivity = false
        if (ticket.assignee && ticket.history && ticket.history.length > 0) {
          const recentAssigneeAction = ticket.history.find(historyItem => {
            if (historyItem.owner && historyItem.owner.toString() === ticket.assignee._id.toString()) {
              const actionTime = moment(historyItem.date)
              const hoursSinceAction = now.diff(actionTime, 'hours')
              return hoursSinceAction < 48
            }
            return false
          })
          hasRecentAssigneeActivity = !!recentAssigneeAction
        }
        
        // Set overdue and escalate_to_admin based on activity
        let overdue = false
        let escalate_to_admin = false
        
        if (!hasRecentAssigneeActivity) {
          overdue = hoursSinceUpdate >= 48
          escalate_to_admin = hoursSinceUpdate >= 96
        }
        
        return {
          ...ticket.toObject(),
          overdue,
          escalate_to_admin
        }
      })

      // Get total count
      const userOwnedCount = await Models.Ticket.countDocuments({
        $or: [
          { owner: req.user._id },
          { assignee: req.user._id }
        ],
        deleted: false
      })

      const groupCount = mappedGroups.length > 0 ? await Models.Ticket.getCountWithObject(mappedGroups, queryObject) : 0
      const totalCount = Math.max(userOwnedCount, groupCount) // Use the larger count

      const totalPages = Math.ceil(totalCount / limit)
      const hasNextPage = page < totalPages - 1
      const hasPrevPage = page > 0

      return apiUtils.sendApiSuccess(res, {
        tickets: processedTickets,
        pagination: {
          currentPage: page,
          totalPages: totalPages,
          totalCount: totalCount,
          limit: limit,
          count: processedTickets.length,
          hasNextPage: hasNextPage,
          hasPrevPage: hasPrevPage,
          nextPage: hasNextPage ? page + 1 : null,
          prevPage: hasPrevPage ? page - 1 : null
        }
      })
    }

    const tickets = await Models.Ticket.getTicketsWithObject(mappedGroups, queryObject)
    const totalCount = await Models.Ticket.getCountWithObject(mappedGroups, queryObject)

    // Add overdue and escalate_to_admin fields to each ticket
    const moment = require('moment')
    const processedTickets = tickets.map(ticket => {
      const now = moment()
      const lastUpdate = ticket.updated ? moment(ticket.updated) : moment(ticket.date)
      const hoursSinceUpdate = now.diff(lastUpdate, 'hours')
      
      // Check for recent assignee activity in the last 48 hours
      let hasRecentAssigneeActivity = false
      if (ticket.assignee && ticket.history && ticket.history.length > 0) {
        const recentAssigneeAction = ticket.history.find(historyItem => {
          if (historyItem.owner && historyItem.owner.toString() === ticket.assignee._id.toString()) {
            const actionTime = moment(historyItem.date)
            const hoursSinceAction = now.diff(actionTime, 'hours')
            return hoursSinceAction < 48
          }
          return false
        })
        hasRecentAssigneeActivity = !!recentAssigneeAction
      }
      
      // Set overdue and escalate_to_admin based on activity
      let overdue = false
      let escalate_to_admin = false
      
      if (!hasRecentAssigneeActivity) {
        overdue = hoursSinceUpdate >= 48
        escalate_to_admin = hoursSinceUpdate >= 96
      }
      
      return {
        ...ticket.toObject(),
        overdue,
        escalate_to_admin
      }
    })

    const totalPages = Math.ceil(totalCount / limit)
    const hasNextPage = page < totalPages - 1
    const hasPrevPage = page > 0

    return apiUtils.sendApiSuccess(res, {
      tickets: processedTickets,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalCount: totalCount,
        limit: limit,
        count: processedTickets.length,
        hasNextPage: hasNextPage,
        hasPrevPage: hasPrevPage,
        nextPage: hasNextPage ? page + 1 : null,
        prevPage: hasPrevPage ? page - 1 : null
      }
    })
  } catch (err) {
    logger.warn(err)
    return apiUtils.sendApiError(res, 500, err.message)
  }
}

// Get tickets owned by the user (created by them)
ticketsV2.getOwned = async (req, res) => {
  const query = req.query
  let limit = 50
  let page = 0

  try {
    limit = query.limit ? parseInt(query.limit) : limit
    page = query.page ? parseInt(query.page) : page
    
    // Validate pagination parameters
    if (limit < 1 || limit > 100) limit = 50
    if (page < 0) page = 0
  } catch (e) {
    logger.warn(e)
    return apiUtils.sendApiError_InvalidPostData(res)
  }

  try {
    // Get tickets owned by user with pagination
    const ownedTickets = await Models.Ticket.find({
      owner: req.user._id,
      deleted: false
    }).populate('owner assignee subscribers comments.owner notes.owner history.owner', 'username fullname email role image title')
      .populate('assignee', 'username fullname email role image title')
      .populate('type tags status group')
      .sort({ uid: -1 })
      .skip(page * limit)
      .limit(limit)

    const totalCount = await Models.Ticket.countDocuments({
      owner: req.user._id,
      deleted: false
    })

    const totalPages = Math.ceil(totalCount / limit)
    const hasNextPage = page < totalPages - 1
    const hasPrevPage = page > 0

    // Add overdue and escalate_to_admin fields to each ticket
    const moment = require('moment')
    const processedTickets = ownedTickets.map(ticket => {
      const now = moment()
      const lastUpdate = ticket.updated ? moment(ticket.updated) : moment(ticket.date)
      const hoursSinceUpdate = now.diff(lastUpdate, 'hours')
      
      // Check for recent assignee activity in the last 48 hours
      let hasRecentAssigneeActivity = false
      if (ticket.assignee && ticket.history && ticket.history.length > 0) {
        const recentAssigneeAction = ticket.history.find(historyItem => {
          if (historyItem.owner && historyItem.owner.toString() === ticket.assignee._id.toString()) {
            const actionTime = moment(historyItem.date)
            const hoursSinceAction = now.diff(actionTime, 'hours')
            return hoursSinceAction < 48
          }
          return false
        })
        hasRecentAssigneeActivity = !!recentAssigneeAction
      }
      
      // Set overdue and escalate_to_admin based on activity
      let overdue = false
      let escalate_to_admin = false
      
      if (!hasRecentAssigneeActivity) {
        overdue = hoursSinceUpdate >= 48
        escalate_to_admin = hoursSinceUpdate >= 96
      }
      
      return {
        ...ticket.toObject(),
        overdue,
        escalate_to_admin
      }
    })

    return apiUtils.sendApiSuccess(res, {
      tickets: processedTickets,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalCount: totalCount,
        limit: limit,
        count: processedTickets.length,
        hasNextPage: hasNextPage,
        hasPrevPage: hasPrevPage,
        nextPage: hasNextPage ? page + 1 : null,
        prevPage: hasPrevPage ? page - 1 : null
      }
    })
  } catch (err) {
    logger.warn(err)
    return apiUtils.sendApiError(res, 500, err.message)
  }
}

// Get tickets assigned to the user
ticketsV2.getAssigned = async (req, res) => {
  const query = req.query
  let limit = 50
  let page = 0

  try {
    limit = query.limit ? parseInt(query.limit) : limit
    page = query.page ? parseInt(query.page) : page
    
    // Validate pagination parameters
    if (limit < 1 || limit > 100) limit = 50
    if (page < 0) page = 0
  } catch (e) {
    logger.warn(e)
    return apiUtils.sendApiError_InvalidPostData(res)
  }

  try {
    // Get tickets assigned to user with pagination
    const assignedTickets = await Models.Ticket.find({
      assignee: req.user._id,
      deleted: false
    }).populate('owner assignee subscribers comments.owner notes.owner history.owner', 'username fullname email role image title')
      .populate('assignee', 'username fullname email role image title')
      .populate('type tags status group')
      .sort({ uid: -1 })
      .skip(page * limit)
      .limit(limit)

    const totalCount = await Models.Ticket.countDocuments({
      assignee: req.user._id,
      deleted: false
    })

    const totalPages = Math.ceil(totalCount / limit)
    const hasNextPage = page < totalPages - 1
    const hasPrevPage = page > 0

    // Add overdue and escalate_to_admin fields to each ticket
    const moment = require('moment')
    const processedTickets = assignedTickets.map(ticket => {
      const now = moment()
      const lastUpdate = ticket.updated ? moment(ticket.updated) : moment(ticket.date)
      const hoursSinceUpdate = now.diff(lastUpdate, 'hours')
      
      // Check for recent assignee activity in the last 48 hours
      let hasRecentAssigneeActivity = false
      if (ticket.assignee && ticket.history && ticket.history.length > 0) {
        const recentAssigneeAction = ticket.history.find(historyItem => {
          if (historyItem.owner && historyItem.owner.toString() === ticket.assignee._id.toString()) {
            const actionTime = moment(historyItem.date)
            const hoursSinceAction = now.diff(actionTime, 'hours')
            return hoursSinceAction < 48
          }
          return false
        })
        hasRecentAssigneeActivity = !!recentAssigneeAction
      }
      
      // Set overdue and escalate_to_admin based on activity
      let overdue = false
      let escalate_to_admin = false
      
      if (!hasRecentAssigneeActivity) {
        overdue = hoursSinceUpdate >= 48
        escalate_to_admin = hoursSinceUpdate >= 96
      }
      
      return {
        ...ticket.toObject(),
        overdue,
        escalate_to_admin
      }
    })

    return apiUtils.sendApiSuccess(res, {
      tickets: processedTickets,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalCount: totalCount,
        limit: limit,
        count: processedTickets.length,
        hasNextPage: hasNextPage,
        hasPrevPage: hasPrevPage,
        nextPage: hasNextPage ? page + 1 : null,
        prevPage: hasPrevPage ? page - 1 : null
      }
    })
  } catch (err) {
    logger.warn(err)
    return apiUtils.sendApiError(res, 500, err.message)
  }
}

ticketsV2.single = async function (req, res) {
  const uid = req.params.uid
  if (!uid) return apiUtils.sendApiError(res, 400, 'Invalid Parameters')
  
  const moment = require('moment')
  const winston = require('../../../logger')
  
  Models.Ticket.getTicketByUid(uid, function (err, ticket) {
    if (err) return apiUtils.sendApiError(res, 500, err)

    // Check overdue status and update if needed
    const now = moment()
    const lastUpdate = ticket.updated ? moment(ticket.updated) : moment(ticket.date)
    const hoursSinceUpdate = now.diff(lastUpdate, 'hours')
    
    let needsUpdate = false
    let updateData = {}
    
    // Check for recent assignee activity in the last 48 hours
    let hasRecentAssigneeActivity = false
    if (ticket.assignee && ticket.history && ticket.history.length > 0) {
      winston.debug(`Ticket ${ticket.uid} - Checking history for assignee: ${ticket.assignee._id}`)
      winston.debug(`Ticket ${ticket.uid} - History items count: ${ticket.history.length}`)
      
      // Check if assignee has any action in history in last 48 hours
      const recentAssigneeAction = ticket.history.find(historyItem => {
        winston.debug(`Ticket ${ticket.uid} - History item owner: ${historyItem.owner}, assignee: ${ticket.assignee._id}`)
        
        if (historyItem.owner && historyItem.owner.toString() === ticket.assignee._id.toString()) {
          const actionTime = moment(historyItem.date)
          const hoursSinceAction = now.diff(actionTime, 'hours')
          winston.debug(`Ticket ${ticket.uid} - Found assignee action ${hoursSinceAction} hours ago`)
          return hoursSinceAction < 48
        }
        return false
      })
      
      hasRecentAssigneeActivity = !!recentAssigneeAction
      winston.debug(`Ticket ${ticket.uid} has recent assignee activity: ${hasRecentAssigneeActivity}`)
    } else {
      winston.debug(`Ticket ${ticket.uid} - No assignee or no history: assignee=${!!ticket.assignee}, history=${!!ticket.history}, historyLength=${ticket.history ? ticket.history.length : 0}`)
      
      // Fallback: If no history, check if ticket was updated recently (might be from comments)
      if (ticket.updated) {
        const hoursSinceUpdate = now.diff(moment(ticket.updated), 'hours')
        if (hoursSinceUpdate < 48) {
          hasRecentAssigneeActivity = true
          winston.debug(`Ticket ${ticket.uid} - Using fallback: updated ${hoursSinceUpdate} hours ago, considering as recent activity`)
        }
      }
    }
    
    // If there's recent assignee activity, set overdue and escalate to false
    if (hasRecentAssigneeActivity) {
      winston.debug(`Ticket ${ticket.uid} - Recent assignee activity found, setting overdue/escalate to false`)
      if (ticket.overdue) {
        updateData.overdue = false
        needsUpdate = true
        winston.debug(`Ticket ${ticket.uid} overdue set to false due to recent assignee activity`)
      }
      if (ticket.escalate_to_admin) {
        updateData.escalate_to_admin = false
        needsUpdate = true
        winston.debug(`Ticket ${ticket.uid} escalation set to false due to recent assignee activity`)
      }
    } else {
      winston.debug(`Ticket ${ticket.uid} - No recent assignee activity, checking time-based rules`)
      // Check for 48-hour overdue (only if no recent assignee activity)
      if (hoursSinceUpdate >= 48 && !ticket.overdue) {
        updateData.overdue = true
        needsUpdate = true
        winston.debug(`Ticket ${ticket.uid} marked as overdue (${hoursSinceUpdate} hours since update)`)
      }
      
      // Check for 96-hour escalation (only if no recent assignee activity)
      if (hoursSinceUpdate >= 96 && !ticket.escalate_to_admin) {
        updateData.escalate_to_admin = true
        needsUpdate = true
        winston.debug(`Ticket ${ticket.uid} escalated to admin (${hoursSinceUpdate} hours since update)`)
      }
    }
    
    winston.debug(`Ticket ${ticket.uid} - Final result: needsUpdate=${needsUpdate}, updateData=${JSON.stringify(updateData)}`)
    
    // Function to send response with ticket
    const sendResponse = (ticketToSend) => {
      // Minimal response-time cleanup for comments/notes HTML wrappers
      const cleaned = ticketToSend.toObject ? ticketToSend.toObject() : ticketToSend
      if (cleaned && Array.isArray(cleaned.comments)) {
        cleaned.comments = cleaned.comments.map(function (c) {
          if (c && typeof c.comment === 'string') {
            c.comment = c.comment
              .replace(/<br\s*\/?\>/gi, ' ')
              .replace(/<\/?p>/gi, '')
              .replace(/\n/g, '')
              .trim()
          }
          return c
        })
      }
      if (cleaned && Array.isArray(cleaned.notes)) {
        cleaned.notes = cleaned.notes.map(function (n) {
          if (n && typeof n.note === 'string') {
            n.note = n.note
              .replace(/<br\s*\/?\>/gi, ' ')
              .replace(/<\/?p>/gi, '')
              .replace(/\n/g, '')
              .trim()
          }
          return n
        })
      }
      if (req.user.role.isAdmin || req.user.role.isAgent) {
        Models.Department.getDepartmentGroupsOfUser(req.user._id, function (err, dbGroups) {
          if (err) return apiUtils.sendApiError(res, 500, err)

          const groups = dbGroups.map(function (g) {
            return g._id.toString()
          })

          if (groups.includes(cleaned.group._id.toString())) {
            return apiUtils.sendApiSuccess(res, { ticket: cleaned })
          } else {
            return apiUtils.sendApiError(res, 403, 'Forbidden')
          }
        })
      } else {
        Models.Group.getAllGroupsOfUser(req.user._id, function (err, userGroups) {
          if (err) return apiUtils.sendApiError(res, 500, err)

          const groupIds = userGroups.map(function (g) {
            return g._id.toString()
          })

          if (groupIds.includes(cleaned.group._id.toString())) {
            return apiUtils.sendApiSuccess(res, { ticket: cleaned })
          } else {
            return apiUtils.sendApiError(res, 403, 'Forbidden')
          }
        })
      }
    }
    
    // Update ticket if needed
    if (needsUpdate) {
      Models.Ticket.findByIdAndUpdate(
        ticket._id,
        { $set: updateData },
        { new: true },
        function (err, updatedTicket) {
          if (err) {
            winston.error(`Error updating ticket ${ticket.uid}: ${err.message}`)
            // Continue with original ticket if update fails
            return sendResponse(ticket)
          }
          
          // Use updated ticket
          return sendResponse(updatedTicket)
        }
      )
    } else {
      // No update needed, return original ticket
      return sendResponse(ticket)
    }
  })
}

ticketsV2.update = function (req, res) {
  const uid = req.params.uid
  const putTicket = req.body.ticket
  if (!uid || !putTicket) return apiUtils.sendApiError(res, 400, 'Invalid Parameters')

  Models.Ticket.getTicketByUid(uid, async function (err, ticket) {
    if (err) return apiUtils.sendApiError(res, 500, err.message)
    if (!ticket) return apiUtils.sendApiError(res, 404, 'Ticket not found')

    try {
      // Update fields if provided
      if (putTicket.subject !== undefined) {
        ticket.subject = putTicket.subject
      }
      
      if (putTicket.issue !== undefined) {
        ticket.issue = putTicket.issue
      }
      
      if (putTicket.description !== undefined) {
        ticket.description = putTicket.description
      }
      
      if (putTicket.type !== undefined) {
        ticket.type = putTicket.type._id || putTicket.type
      }
      
      if (putTicket.status !== undefined) {
        ticket.status = putTicket.status._id || putTicket.status
      }
      
      if (putTicket.priority !== undefined) {
        ticket.priority = putTicket.priority._id || putTicket.priority
      }
      
      if (putTicket.assignee !== undefined) {
        ticket.assignee = putTicket.assignee._id || putTicket.assignee
      }
      
      if (putTicket.group !== undefined) {
        ticket.group = putTicket.group._id || putTicket.group
      }

      // Update timestamp
      ticket.updated = Date.now()

      // Save the updated ticket
      const updatedTicket = await ticket.save()
      
      // Populate related fields
      await updatedTicket.populate('group owner priority type status assignee')

      return apiUtils.sendApiSuccess(res, updatedTicket)
    } catch (error) {
      return apiUtils.sendApiError(res, 500, error.message)
    }
  })
}

ticketsV2.batchUpdate = function (req, res) {
  const batch = req.body.batch
  if (!_.isArray(batch)) return apiUtils.sendApiError_InvalidPostData(res)

  async.each(
    batch,
    function (batchTicket, next) {
      Models.Ticket.getTicketById(batchTicket.id, function (err, ticket) {
        if (err) return next(err)

        if (!_.isUndefined(batchTicket.status)) {
          ticket.status = batchTicket.status
          const HistoryItem = {
            action: 'ticket:set:status',
            description: 'status set to: ' + batchTicket.status,
            owner: req.user._id
          }

          ticket.history.push(HistoryItem)
        }

        return ticket.save(next)
      })
    },
    function (err) {
      if (err) return apiUtils.sendApiError(res, 400, err.message)

      return apiUtils.sendApiSuccess(res)
    }
  )
}

ticketsV2.delete = function (req, res) {
  const uid = req.params.uid
  if (!uid) return apiUtils.sendApiError(res, 400, 'Invalid Parameters')

  Models.Ticket.softDeleteUid(uid, function (err, success) {
    if (err) return apiUtils.sendApiError(res, 500, err.message)
    if (!success) return apiUtils.sendApiError(res, 500, 'Unable to delete ticket')

    return apiUtils.sendApiSuccess(res, { deleted: true })
  })
}

ticketsV2.permDelete = function (req, res) {
  const id = req.params.id
  if (!id) return apiUtils.sendApiError(res, 400, 'Invalid Parameters')

  Models.Ticket.deleteOne({ _id: id }, function (err, success) {
    if (err) return apiUtils.sendApiError(res, 400, err.message)
    if (!success) return apiUtils.sendApiError(res, 400, 'Unable to delete ticket')

    return apiUtils.sendApiSuccess(res, { deleted: true })
  })
}

ticketsV2.transferToThirdParty = async (req, res) => {
  const uid = req.params.uid
  if (!uid) return apiUtils.sendApiError(res, 400, 'Invalid Parameters')

  try {
    const ticket = await Models.Ticket.findOne({ uid })
    if (!ticket) return apiUtils.sendApiError(res, 400, 'Ticket not found')

    ticket.status = 3
    await ticket.save()

    const request = require('axios')
    const nconf = require('nconf')
    const thirdParty = nconf.get('thirdParty')
    const url = thirdParty.url + '/api/v2/tickets'

    const ticketObj = {
      subject: ticket.subject,
      description: ticket.issue,
      email: ticket.owner.email,
      status: 2,
      priority: 2
    }

    await request.post(url, ticketObj, { auth: { username: thirdParty.apikey, password: '1' } })
    return apiUtils.sendApiSuccess(res)
  } catch (error) {
    return apiUtils.sendApiError(res, 500, error.message)
  }
}

ticketsV2.info = {}
ticketsV2.info.types = async (req, res) => {
  try {
    const ticketTypes = await Models.TicketType.find({})
    const priorities = await Models.Priority.find({})

    return apiUtils.sendApiSuccess(res, { ticketTypes, priorities })
  } catch (err) {
    logger.warn(err)
    return apiUtils.sendApiError(res, 500, err.message)
  }
}

ticketsV2.info.tags = async (req, res) => {
  try {
    const tags = await Models.TicketTags.find({}).sort('normalized')

    return apiUtils.sendApiSuccess(res, { tags })
  } catch (err) {
    logger.warn(err)
    return apiUtils.sendApiError(res, 500, err.message)
  }
}

// Admin-only endpoint to view ALL tickets with filtering and pagination
ticketsV2.adminGetAll = async (req, res) => {
  // Check if user is admin
  if (!req.user.role.isAdmin) {
    return apiUtils.sendApiError(res, 403, 'Admin access required')
  }

  const query = req.query
  let limit = 50
  let page = 0
  let priority = null
  let status = null
  let group = null
  let assignee = null
  let owner = null

  try {
    // Parse pagination parameters
    limit = query.limit ? parseInt(query.limit) : limit
    page = query.page ? parseInt(query.page) : page
    
    // Parse filter parameters
    if (query.priority !== undefined && query.priority !== '') {
      priority = query.priority  // Keep as string for ObjectId
    }
    if (query.status !== undefined && query.status !== '') {
      status = query.status  // Keep as string for ObjectId
    }
    if (query.group !== undefined && query.group !== '') {
      group = query.group
    }
    if (query.assignee !== undefined && query.assignee !== '') {
      assignee = query.assignee
    }
    if (query.owner !== undefined && query.owner !== '') {
      owner = query.owner
    }

    // Validate pagination parameters
    if (limit < 1 || limit > 200) limit = 50 // Allow higher limit for admins
    if (page < 0) page = 0
  } catch (e) {
    logger.warn(e)
    return apiUtils.sendApiError_InvalidPostData(res)
  }

  try {
    // Build query object
    const queryObject = {
      deleted: false
    }

    // Add filters if specified
    if (priority !== null) {
      queryObject.priority = priority
    }
    if (status !== null) {
      queryObject.status = status
    }
    if (group !== null) {
      queryObject.group = group
    }
    if (assignee !== null) {
      queryObject.assignee = assignee
    }
    if (owner !== null) {
      queryObject.owner = owner
    }

    // Get all tickets with filters (no group restrictions for admin)
    const tickets = await Models.Ticket.find(queryObject)
      .populate('owner assignee subscribers comments.owner notes.owner history.owner', 'username fullname email role image title')
      .populate('assignee', 'username fullname email role image title')
      .populate('type tags status group priority')
      .sort({ uid: -1 })
      .skip(page * limit)
      .limit(limit)

    // Get total count for pagination
    const totalCount = await Models.Ticket.countDocuments(queryObject)

    // Calculate pagination
    const totalPages = Math.ceil(totalCount / limit)
    const hasNextPage = page < totalPages - 1
    const hasPrevPage = page > 0

    // Get summary statistics
    const priorityStats = await Models.Ticket.aggregate([
      { $match: { deleted: false } },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ])

    const statusStats = await Models.Ticket.aggregate([
      { $match: { deleted: false } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ])

    const overdueCount = await Models.Ticket.countDocuments({
      deleted: false,
      overdue: true
    })

    const escalatedCount = await Models.Ticket.countDocuments({
      deleted: false,
      escalate_to_admin: true
    })

    return apiUtils.sendApiSuccess(res, {
      tickets: tickets,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalCount: totalCount,
        limit: limit,
        count: tickets.length,
        hasNextPage: hasNextPage,
        hasPrevPage: hasPrevPage,
        nextPage: hasNextPage ? page + 1 : null,
        prevPage: hasPrevPage ? page - 1 : null
      },
      filters: {
        priority: priority,
        status: status,
        group: group,
        assignee: assignee,
        owner: owner
      },
      statistics: {
        priorityBreakdown: priorityStats,
        statusBreakdown: statusStats,
        overdueCount: overdueCount,
        escalatedCount: escalatedCount
      }
    })

  } catch (err) {
    logger.warn(err)
    return apiUtils.sendApiError(res, 500, err.message)
  }
}

// Admin endpoint to get tickets by specific priority
ticketsV2.adminGetByPriority = async (req, res) => {
  // Check if user is admin
  if (!req.user.role.isAdmin) {
    return apiUtils.sendApiError(res, 403, 'Admin access required')
  }

  const priority = req.params.priorityId
  if (!priority) {
    return apiUtils.sendApiError(res, 400, 'Priority parameter is required')
  }

  const query = req.query
  let limit = 50
  let page = 0

  try {
    limit = query.limit ? parseInt(query.limit) : limit
    page = query.page ? parseInt(query.page) : page
    
    if (limit < 1 || limit > 200) limit = 50
    if (page < 0) page = 0
  } catch (e) {
    logger.warn(e)
    return apiUtils.sendApiError_InvalidPostData(res)
  }

  try {
    const tickets = await Models.Ticket.find({
      priority: priority,
      deleted: false
    })
      .populate('owner assignee subscribers comments.owner notes.owner history.owner', 'username fullname email role image title')
      .populate('assignee', 'username fullname email role image title')
      .populate('type tags status group priority')
      .sort({ uid: -1 })
      .skip(page * limit)
      .limit(limit)

    const totalCount = await Models.Ticket.countDocuments({
      priority: priority,
      deleted: false
    })

    const totalPages = Math.ceil(totalCount / limit)
    const hasNextPage = page < totalPages - 1
    const hasPrevPage = page > 0

    return apiUtils.sendApiSuccess(res, {
      tickets: tickets,
      priority: priority,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalCount: totalCount,
        limit: limit,
        count: tickets.length,
        hasNextPage: hasNextPage,
        hasPrevPage: hasPrevPage,
        nextPage: hasNextPage ? page + 1 : null,
        prevPage: hasPrevPage ? page - 1 : null
      }
    })

  } catch (err) {
    logger.warn(err)
    return apiUtils.sendApiError(res, 500, err.message)
  }
}

// Admin endpoint to get tickets by specific status
ticketsV2.adminGetByStatus = async (req, res) => {
  // Check if user is admin
  if (!req.user.role.isAdmin) {
    return apiUtils.sendApiError(res, 403, 'Admin access required')
  }

  const status = req.params.statusId
  if (!status) {
    return apiUtils.sendApiError(res, 400, 'Status parameter is required')
  }

  const query = req.query
  let limit = 50
  let page = 0

  try {
    limit = query.limit ? parseInt(query.limit) : limit
    page = query.page ? parseInt(query.page) : page
    
    if (limit < 1 || limit > 200) limit = 50
    if (page < 0) page = 0
  } catch (e) {
    logger.warn(e)
    return apiUtils.sendApiError_InvalidPostData(res)
  }

  try {
    const tickets = await Models.Ticket.find({
      status: status,
      deleted: false
    })
      .populate('owner assignee subscribers comments.owner notes.owner history.owner', 'username fullname email role image title')
      .populate('assignee', 'username fullname email role image title')
      .populate('type tags status group priority')
      .sort({ uid: -1 })
      .skip(page * limit)
      .limit(limit)

    const totalCount = await Models.Ticket.countDocuments({
      status: status,
      deleted: false
    })

    const totalPages = Math.ceil(totalCount / limit)
    const hasNextPage = page < totalPages - 1
    const hasPrevPage = page > 0

    return apiUtils.sendApiSuccess(res, {
      tickets: tickets,
      status: status,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalCount: totalCount,
        limit: limit,
        count: tickets.length,
        hasNextPage: hasNextPage,
        hasPrevPage: hasPrevPage,
        nextPage: hasNextPage ? page + 1 : null,
        prevPage: hasPrevPage ? page - 1 : null
      }
    })

  } catch (err) {
    logger.warn(err)
    return apiUtils.sendApiError(res, 500, err.message)
  }
}

module.exports = ticketsV2
