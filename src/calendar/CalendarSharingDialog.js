// @flow

import {Dialog, DialogType} from "../gui/base/Dialog"
import m from "mithril"
import stream from "mithril/stream/stream.js"
import {GroupMemberTypeRef} from "../api/entities/sys/GroupMember"
import {load, loadAll} from "../api/main/Entity"
import type {TableLineAttrs} from "../gui/base/TableN"
import {ColumnWidth, TableN} from "../gui/base/TableN"
import {downcast, neverNull} from "../api/common/utils/Utils"
import {Icons} from "../gui/base/icons/Icons"
import {lang} from "../misc/LanguageViewModel"
import {Bubble, BubbleTextField} from "../gui/base/BubbleTextField"
import {MailAddressBubbleHandler} from "../misc/MailAddressBubbleHandler"
import {createRecipientInfo, getDisplayText} from "../mail/MailUtils"
import {attachDropdown} from "../gui/base/DropdownN"
import type {ButtonAttrs} from "../gui/base/ButtonN"
import {ButtonType} from "../gui/base/ButtonN"
import {findAndRemove, remove} from "../api/common/utils/ArrayUtils"
import {showProgressDialog} from "../gui/base/ProgressDialog"
import {GroupTypeRef} from "../api/entities/sys/Group"
import type {ShareCapabilityEnum} from "../api/common/TutanotaConstants"
import {OperationType, ShareCapability} from "../api/common/TutanotaConstants"
import {getElementId, isSameId} from "../api/common/EntityFunctions"
import {getCalendarName, getCapabilityText, hasCapabilityOnGroup, isSharedGroupOwner} from "./CalendarUtils"
import {worker} from "../api/main/WorkerClient"
import {DropDownSelectorN} from "../gui/base/DropDownSelectorN"
import {SentGroupInvitationTypeRef} from "../api/entities/sys/SentGroupInvitation"
import {NotFoundError, PreconditionFailedError} from "../api/common/error/RestError"
import {showSharingBuyDialog} from "../subscription/WhitelabelAndSharingBuyDialog"
import {logins} from "../api/main/LoginController"
import {RecipientsNotFoundError} from "../api/common/error/RecipientsNotFoundError"
import type {EntityEventsListener} from "../api/main/EventController"
import {isUpdateForTypeRef} from "../api/main/EventController"
import {locator} from "../api/main/MainLocator"
import type {GroupDetails, GroupMemberInfo} from "./CalendarSharingUtils"
import {loadGroupInfoForMember, loadGroupMembers, sendShareNotificationEmail} from "./CalendarSharingUtils"


type CalendarSharingDialogAttrs = {
	groupDetails: GroupDetails
}


export function showCalendarSharingDialog(groupInfo: GroupInfo) {
	showProgressDialog("loading_msg", loadGroupDetails(groupInfo)
		.then(groupDetails => {

			const eventListener: EntityEventsListener = (updates, eventOwnerGroupId) => {
				updates.forEach(update => {
						if (!isSameId(eventOwnerGroupId, groupDetails.group._id)) {
							//ignore events of differen group here
							return
						}
						if (isUpdateForTypeRef(SentGroupInvitationTypeRef, update)) {
							if (update.operation === OperationType.CREATE
								&& isSameId(update.instanceListId, groupDetails.group.invitations)) {
								load(SentGroupInvitationTypeRef, [update.instanceListId, update.instanceId]).then(instance => {
									if (instance) {
										groupDetails.sentGroupInvitations.push(instance)
										m.redraw()
									}
								}).catch(NotFoundError, e => console.log("sent invitation not found", update))
							}
							if (update.operation === OperationType.DELETE) {
								findAndRemove(groupDetails.sentGroupInvitations, (sentGroupInvitation) => isSameId(getElementId(sentGroupInvitation), update.instanceId))
								m.redraw()
							}
						} else if (isUpdateForTypeRef(GroupMemberTypeRef, update)) {
							console.log("update received in share dialog", update)
							if (update.operation === OperationType.CREATE
								&& isSameId(update.instanceListId, groupDetails.group.members)) {
								load(GroupMemberTypeRef, [update.instanceListId, update.instanceId]).then(instance => {
									if (instance) {
										return loadGroupInfoForMember(instance).then(groupMemberInfo => {
											console.log("new member", groupMemberInfo)
											groupDetails.memberInfos.push(groupMemberInfo)
											m.redraw()
										})
									}
								}).catch(NotFoundError, e => console.log("group member not found", update))
							}
							if (update.operation === OperationType.DELETE) {
								findAndRemove(groupDetails.memberInfos, (memberInfo) => isSameId(getElementId(memberInfo.member), update.instanceId))
								m.redraw()
							}
						}
					}
				)
			}
			locator.eventController.addEntityListener(eventListener)

			const unsubscribeEventListener = () => {
				locator.eventController.removeEntityListener(eventListener)
			}


			const dialog = Dialog.showActionDialog({
					title: lang.get("sharing_label"),
					type: DialogType.EditMedium,
					child: () => m(CalendarSharingDialogContent, {
						groupDetails
					}),
					okAction: null,
					cancelAction: () => unsubscribeEventListener(),
					cancelActionTextId: 'close_alt'
				}
			)

		}))

}


function loadGroupDetails(groupInfo: GroupInfo): Promise<GroupDetails> {
	return load(GroupTypeRef, groupInfo.group).then(group => {
		return Promise.all([
				loadAll(SentGroupInvitationTypeRef, group.invitations),
				loadGroupMembers(group)
			]
		).then(([invitations, memberInfos]) => {
			return {group, info: groupInfo, memberInfos, sentGroupInvitations: invitations}
		})
	})
}


class CalendarSharingDialogContent implements MComponent<CalendarSharingDialogAttrs> {

	constructor() {
	}

	view(vnode: Vnode<CalendarSharingDialogAttrs>): ?Children {
		return m(".flex.col.pt-s", [
			m(TableN, {
				columnHeading: [() => lang.get("participants_label", {"{name}": getCalendarName(vnode.attrs.groupDetails.info.name)})],
				columnWidths: [ColumnWidth.Largest, ColumnWidth.Largest],
				lines: this._renderMemberInfos(vnode.attrs.groupDetails).concat(this._renderGroupInvitations(vnode.attrs.groupDetails)),
				showActionButtonColumn: true,
				addButtonAttrs: {
					label: "addParticipant_action",
					click: () => showAddParticipantDialog(vnode.attrs.groupDetails.info),
					icon: () => Icons.Add,
					isVisible: () => hasCapabilityOnGroup(logins.getUserController().user, vnode.attrs.groupDetails.group, ShareCapability.Invite)
				},
			})
		])
	}

	_renderGroupInvitations(groupDetails: GroupDetails): Array<TableLineAttrs> {
		return groupDetails.sentGroupInvitations.map((sentGroupInvitation) => {
			return {
				cells: () => [
					{
						main: sentGroupInvitation.inviteeMailAddress,
						info: lang.get("invited_label") + ", " + getCapabilityText(downcast(sentGroupInvitation.capability)),
						mainStyle: ".i"
					}
				],
				actionButtonAttrs: {
					label: "remove_action",
					click: () => {
						worker.rejectGroupInvitation(neverNull(sentGroupInvitation.receivedInvitation))
					},
					icon: () => Icons.Cancel,
					isVisible: () => this._isDeleteInvitationButtonVisible(groupDetails.group, sentGroupInvitation)
				}
			}
		})
	}

	_renderMemberInfos(groupDetails: GroupDetails): Array<TableLineAttrs> {
		return groupDetails.memberInfos.map((memberInfo) => {
			return {
				cells: () => [
					{
						main: getDisplayText(memberInfo.info.name, neverNull(memberInfo.info.mailAddress), false),
						info: (isSharedGroupOwner(groupDetails.group, memberInfo.member.user) ? lang.get("owner_label") : lang.get("member_label"))
							+ ", " + getCapabilityText(this._getMemberCabability(memberInfo, groupDetails))
					}
				], actionButtonAttrs: {
					label: "delete_action",
					icon: () => Icons.Cancel,
					click: () => {
						worker.removeUserFromGroup(memberInfo.member.user, groupDetails.group._id)
					},
					isVisible: () => this._isDeleteMembershipVisible(groupDetails.group, memberInfo)
				}
			}
		})
	}


	_getMemberCabability(memberInfo: GroupMemberInfo, groupDetails: GroupDetails): ?ShareCapabilityEnum {
		if (isSharedGroupOwner(groupDetails.group, memberInfo.member.user)) {
			return ShareCapability.Invite
		}
		return downcast(memberInfo.member.capability)
	}

	_isDeleteInvitationButtonVisible(group: Group, sentGroupInvitation: SentGroupInvitation): boolean {
		return hasCapabilityOnGroup(logins.getUserController().user, group, ShareCapability.Invite)
			|| isSharedGroupOwner(group, logins.getUserController().user._id)
	}

	_isDeleteMembershipVisible(group: Group, memberInfo: GroupMemberInfo): boolean {
		return (hasCapabilityOnGroup(logins.getUserController().user, group, ShareCapability.Invite)
			|| isSameId(logins.getUserController().user._id, memberInfo.member.user))
			&& !isSharedGroupOwner(group, memberInfo.member.user)
	}


}

function showAddParticipantDialog(sharedGroupInfo: GroupInfo) {
	const invitePeopleValueTextField: BubbleTextField<RecipientInfo> = new BubbleTextField("shareWithEmailRecipient_label", new MailAddressBubbleHandler({
		createBubble(name: ? string, mailAddress: string, contact: ? Contact): Bubble<RecipientInfo> {
			let recipientInfo = createRecipientInfo(mailAddress, name, contact, false)
			let bubbleWrapper = {}
			bubbleWrapper.buttonAttrs = attachDropdown({
				label: () => getDisplayText(recipientInfo.name, mailAddress, false),
				type: ButtonType.TextBubble,
				isSelected: () => false,
			}, () => {
				return this._createBubbleContextButtons(recipientInfo.name, mailAddress)
			})
			bubbleWrapper.bubble = new Bubble(recipientInfo, neverNull(bubbleWrapper.buttonAttrs), mailAddress)
			return bubbleWrapper.bubble
		},

		_createBubbleContextButtons(name: string, mailAddress: string): Array<ButtonAttrs | string> {
			let buttonAttrs = [mailAddress]
			buttonAttrs.push({
				label: "remove_action",
				type: ButtonType.Secondary,
				click: () => {
					const bubbleToRemove = invitePeopleValueTextField.bubbles.find((bubble) => bubble.entity.mailAddress == mailAddress)
					if (bubbleToRemove) {
						remove(invitePeopleValueTextField.bubbles, bubbleToRemove)
					}
				}
			})
			return buttonAttrs
		}

	}))
	const capapility: Stream<ShareCapabilityEnum> = stream(ShareCapability.Read)


	let dialog = Dialog.showActionDialog({

		type: DialogType.EditMedium,
		title: () => lang.get("addParticipant_action"),
		child: () => [
			m(".pt", lang.get("shareCalendarWarning_msg") + " " + lang.get("shareCalendarWarningAliases_msg")),
			m(invitePeopleValueTextField),
			m(DropDownSelectorN, {
				label: "permissions_label",
				items: [
					{name: getCapabilityText(ShareCapability.Invite), value: ShareCapability.Invite},
					{name: getCapabilityText(ShareCapability.Write), value: ShareCapability.Write},
					{name: getCapabilityText(ShareCapability.Read), value: ShareCapability.Read},
				],
				selectedValue: capapility,
				dropdownWidth: 300
			})
		],
		okAction: () => {
			invitePeopleValueTextField.createBubbles()
			if (invitePeopleValueTextField.bubbles.length === 0) {
				return Dialog.error("noRecipients_msg")

			} else {
				const recipients = invitePeopleValueTextField.bubbles.map(b => b.entity)
				sendCalendarInvitation(sharedGroupInfo, recipients, capapility())
					.then(invitedMailAddresses => {
							if (invitedMailAddresses.length > 0) {
								dialog.close()
								sendShareNotificationEmail(sharedGroupInfo, invitedMailAddresses.map(ma => createRecipientInfo(ma.address, null, null, true)))
							}
						}
					)
			}

		},
		okActionTextId: 'invite_alt'
	}).setCloseHandler(() => {
		dialog.close()
	})
}

function sendCalendarInvitation(sharedGroupInfo: GroupInfo, recipients: Array<RecipientInfo>, capability: ShareCapabilityEnum): Promise<Array<MailAddress>> {
	return showProgressDialog("calendarInvitationProgress_msg",
		worker.sendGroupInvitation(sharedGroupInfo, getCalendarName(sharedGroupInfo.name), recipients, capability)
	).then((groupInvitationReturn) => {
		if (groupInvitationReturn.existingMailAddresses.length > 0 || groupInvitationReturn.invalidMailAddresses.length > 0) {
			let existingMailAddresses = groupInvitationReturn.existingMailAddresses.map(ma => ma.address).join("\n")
			let invalidMailAddresses = groupInvitationReturn.invalidMailAddresses.map(ma => ma.address).join("\n")
			Dialog.error(() => {
				let msg = ""
				msg += existingMailAddresses.length === 0 ? "" : lang.get("existingMailAddress_msg") + "\n" + existingMailAddresses
				msg += existingMailAddresses.length === 0 && invalidMailAddresses.length === 0 ? "" : "\n\n"
				msg += invalidMailAddresses.length === 0 ? "" : lang.get("invalidMailAddress_msg") + "\n" + invalidMailAddresses
				return msg
			})
		}
		return groupInvitationReturn.invitedMailAddresses
	}).catch(PreconditionFailedError, e => {
		if (logins.getUserController().isGlobalAdmin()) {
			return Dialog.confirm("sharingFeatureNotOrderedAdmin_msg")
			             .then(confirmed => {
				             if (confirmed) {
					             showSharingBuyDialog(true)
				             }
			             }).return([])
		} else {
			return Dialog.error("sharingFeatureNotOrderedUser_msg").return([])
		}
	}).catch(RecipientsNotFoundError, e => {
		let invalidRecipients = e.message.join("\n")
		return Dialog.error(() => lang.get("invalidRecipients_msg") + "\n"
			+ invalidRecipients).return([])
	})
}

